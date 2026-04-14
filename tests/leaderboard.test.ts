import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ELO_NORM_MAX,
  ELO_NORM_MIN,
  LEADERBOARD_URL,
  LeaderboardCache,
  QUALITY_DEFAULT,
  QUALITY_MAX,
  QUALITY_MIN,
  THINKING_MULTIPLIERS,
  TIER1_ELO_MIN,
  TIER2_ELO_MIN,
  fuzzyMatch,
  normalizeElo,
} from "../src/leaderboard.js";

// ---------------------------------------------------------------------------
// Mock fetch — avoid all network IO
// ---------------------------------------------------------------------------

const origFetch = globalThis.fetch;

interface MockResponseInit {
  status?: number;
  body?: unknown;
  throwError?: Error;
}

function makeFetchMock(init: MockResponseInit) {
  return vi.fn(async (input: unknown, _options?: unknown) => {
    // Verify the User-Agent header was sent (it's load-bearing vs the real API).
    const opts = _options as RequestInit | undefined;
    const ua =
      opts?.headers instanceof Headers
        ? opts.headers.get("User-Agent")
        : (opts?.headers as Record<string, string> | undefined)?.["User-Agent"];
    expect(ua).toBe("coding-agent-mcp/1.0 (leaderboard quality scoring)");
    expect(String(input)).toBe(LEADERBOARD_URL);

    if (init.throwError) {
      throw init.throwError;
    }
    const status = init.status ?? 200;
    return new Response(JSON.stringify(init.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

function installFetch(mock: ReturnType<typeof makeFetchMock>) {
  globalThis.fetch = mock as unknown as typeof fetch;
}

beforeEach(() => {
  // Clear any prior mocks between tests.
  globalThis.fetch = origFetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// normalizeElo
// ---------------------------------------------------------------------------

describe("normalizeElo", () => {
  it("maps ELO_NORM_MIN to QUALITY_MIN", () => {
    expect(normalizeElo(ELO_NORM_MIN)).toBeCloseTo(QUALITY_MIN, 10);
  });

  it("maps ELO_NORM_MAX to QUALITY_MAX", () => {
    expect(normalizeElo(ELO_NORM_MAX)).toBeCloseTo(QUALITY_MAX, 10);
  });

  it("midpoint maps to midpoint", () => {
    // (1000 + 1600) / 2 = 1300 → (0.60 + 1.00) / 2 = 0.80
    expect(normalizeElo(1300)).toBeCloseTo(0.8, 10);
  });

  it("clamps values below ELO_NORM_MIN", () => {
    expect(normalizeElo(500)).toBeCloseTo(QUALITY_MIN, 10);
    expect(normalizeElo(-100)).toBeCloseTo(QUALITY_MIN, 10);
  });

  it("clamps values above ELO_NORM_MAX", () => {
    expect(normalizeElo(2000)).toBeCloseTo(QUALITY_MAX, 10);
    expect(normalizeElo(99_999)).toBeCloseTo(QUALITY_MAX, 10);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatch — mirrors Python _fuzzy_match three-tier fallback
// ---------------------------------------------------------------------------

describe("fuzzyMatch", () => {
  const scores: Record<string, number> = {
    "claude opus 4.6": 1540,
    "claude opus 4.6 (thinking)": 1546,
    "claude sonnet 4.6": 1310,
    "gpt-5.4": 1480,
    "gemini 2.5 pro": 1380,
  };

  it("exact case-insensitive match wins", () => {
    // Exact lowercased hit — returns that specific score.
    expect(fuzzyMatch("claude opus 4.6", scores)).toBe(1540);
    expect(fuzzyMatch("CLAUDE OPUS 4.6", scores)).toBe(1540);
  });

  it("substring match prefers shortest", () => {
    // "opus 4.6" appears in two entries; the shorter ("claude opus 4.6")
    // should win.
    const result = fuzzyMatch("opus 4.6", scores);
    expect(result).toBe(1540);
  });

  it("substring match single hit", () => {
    expect(fuzzyMatch("gpt-5.4", scores)).toBe(1480);
  });

  it("words-present fallback when no substring matches", () => {
    // "thinking opus" doesn't appear as substring but both words appear
    // in "claude opus 4.6 (thinking)".
    const result = fuzzyMatch("thinking opus", scores);
    expect(result).toBe(1546);
  });

  it("returns null when no match is found", () => {
    expect(fuzzyMatch("nonexistent-model-xyz", scores)).toBeNull();
  });

  it("returns null for empty query", () => {
    expect(fuzzyMatch("", scores)).toBeNull();
    expect(fuzzyMatch("   ", scores)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LeaderboardCache
// ---------------------------------------------------------------------------

describe("LeaderboardCache.getQualityScore", () => {
  it("returns normalized ELO × thinking multiplier for a known model", async () => {
    const mock = makeFetchMock({
      body: {
        models: [
          { model: "TestModel", score: 1300 },
          { model: "Other", score: 1100 },
        ],
      },
    });
    installFetch(mock);

    // Use a fresh cache with a path that won't load any benchmark file.
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    const { qualityScore, elo } = await cache.getQualityScore(
      "testmodel",
      "medium",
    );

    // normalized(1300) = 0.80; mult(medium) = 1.07 → 0.856
    expect(qualityScore).toBeCloseTo(0.8 * 1.07, 8);
    expect(elo).toBe(1300);
  });

  it("falls back to QUALITY_DEFAULT × thinking mult when model unknown", async () => {
    const mock = makeFetchMock({
      body: { models: [{ model: "OtherModel", score: 1400 }] },
    });
    installFetch(mock);

    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    const { qualityScore, elo } = await cache.getQualityScore(
      "unknown-xyz",
      "high",
    );

    expect(qualityScore).toBeCloseTo(QUALITY_DEFAULT * 1.15, 8);
    expect(elo).toBeNull();
  });

  it("applies thinking multiplier of 1.0 when thinkingLevel is undefined", async () => {
    const mock = makeFetchMock({
      body: { models: [{ model: "M", score: 1300 }] },
    });
    installFetch(mock);

    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    const { qualityScore } = await cache.getQualityScore("m", undefined);
    expect(qualityScore).toBeCloseTo(0.8, 8);
  });
});

describe("LeaderboardCache.autoTier", () => {
  it("ELO 1350 → tier 1", async () => {
    installFetch(
      makeFetchMock({
        body: { models: [{ model: "A", score: TIER1_ELO_MIN }] },
      }),
    );
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    expect(await cache.autoTier("a", "medium", 3)).toBe(1);
  });

  it("ELO 1200 → tier 2", async () => {
    installFetch(
      makeFetchMock({
        body: { models: [{ model: "B", score: TIER2_ELO_MIN }] },
      }),
    );
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    expect(await cache.autoTier("b", "medium", 3)).toBe(2);
  });

  it("ELO 1199 → tier 3", async () => {
    installFetch(
      makeFetchMock({
        body: { models: [{ model: "C", score: 1199 }] },
      }),
    );
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    expect(await cache.autoTier("c", "medium", 1)).toBe(3);
  });

  it("high thinking gives a 25-point ELO boost to thresholds (1325 → tier 1)", async () => {
    installFetch(
      makeFetchMock({
        body: { models: [{ model: "D", score: 1325 }] },
      }),
    );
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    // 1325 + 25 (high boost) = 1350 ≥ TIER1_ELO_MIN → tier 1
    expect(await cache.autoTier("d", "high", 3)).toBe(1);
    // Without the boost it would be tier 2.
  });

  it("falls back to fallbackTier for unknown model", async () => {
    installFetch(makeFetchMock({ body: { models: [] } }));
    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    expect(await cache.autoTier("unknown", "medium", 2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fetch-retry suppression
// ---------------------------------------------------------------------------

describe("LeaderboardCache fetch retry suppression", () => {
  it("does not re-fetch after a failure within the TTL window", async () => {
    // First call fails.
    const mock = vi.fn(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = mock as unknown as typeof fetch;

    const cache = new LeaderboardCache("/nonexistent/path/benchmarks.json");
    const first = await cache.getElo("anything");
    expect(first).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);

    // Second call should be suppressed — data is empty and fetchFailed flag is set.
    const second = await cache.getElo("anything");
    expect(second).toBeNull();
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// Sanity check THINKING_MULTIPLIERS are what the contract says.
describe("THINKING_MULTIPLIERS constants", () => {
  it("matches the load-bearing values", () => {
    expect(THINKING_MULTIPLIERS["high"]).toBe(1.15);
    expect(THINKING_MULTIPLIERS["medium"]).toBe(1.07);
    expect(THINKING_MULTIPLIERS["low"]).toBe(1.0);
  });
});
