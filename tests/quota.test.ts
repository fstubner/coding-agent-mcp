import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the rate-limit-header parsers. Agent 1 owns their real implementation;
// we only need a stable stub here to verify wiring.
vi.mock("../src/dispatchers/shared/rate-limit-headers.js", () => ({
  parseRemaining: (h: Record<string, string>) => {
    const v = h["x-ratelimit-remaining"];
    return v !== undefined ? Number(v) : null;
  },
  parseLimit: (h: Record<string, string>) => {
    const v = h["x-ratelimit-limit"];
    return v !== undefined ? Number(v) : null;
  },
}));

// Stub the Dispatcher base module (Agent 1 owns it). Only the type shape
// matters for TS resolution; runtime import just needs to not throw.
vi.mock("../src/dispatchers/base.js", () => ({}));

// Stub ./types (Agent 1 owns it).
vi.mock("../src/types.js", () => ({}));

import { QuotaCache, QuotaState } from "../src/quota.js";
import type { Dispatcher } from "../src/dispatchers/base.js";
import type { DispatchResult, QuotaInfo } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "quota-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function tmpFile(name = "quota_state.json"): string {
  return path.join(tmpDir, name);
}

function makeDispatcher(
  id: string,
  checkQuota: () => Promise<QuotaInfo> = async () => ({
    service: id,
    source: "unknown",
  }),
): Dispatcher {
  return { id, checkQuota } as unknown as Dispatcher;
}

// ---------------------------------------------------------------------------
// QuotaState.score
// ---------------------------------------------------------------------------

describe("QuotaState.score", () => {
  it("uses remaining / limit branch when both > 0", () => {
    const s = new QuotaState("svc");
    s.remaining = 30;
    s.limit = 100;
    expect(s.score).toBeCloseTo(0.3, 8);
  });

  it("uses (limit - used) / limit branch when remaining is null", () => {
    const s = new QuotaState("svc");
    s.used = 75;
    s.limit = 100;
    expect(s.score).toBeCloseTo(0.25, 8);
  });

  it("defaults to 1.0 when nothing is known", () => {
    const s = new QuotaState("svc");
    expect(s.score).toBe(1.0);
  });

  it("defaults to 1.0 when limit is zero", () => {
    const s = new QuotaState("svc");
    s.remaining = 5;
    s.limit = 0;
    expect(s.score).toBe(1.0);
  });

  it("clamps score to [0, 1]", () => {
    const s = new QuotaState("svc");
    s.remaining = 1000;
    s.limit = 100;
    expect(s.score).toBe(1.0);

    s.remaining = -50;
    s.limit = 100;
    expect(s.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QuotaCache.recordResult — updates state from rate-limit headers
// ---------------------------------------------------------------------------

describe("QuotaCache.recordResult", () => {
  it("updates state from rateLimitHeaders via parseRemaining / parseLimit", () => {
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: tmpFile() },
    );

    const result: DispatchResult = {
      output: "",
      service: "svc",
      success: true,
      rateLimitHeaders: {
        "x-ratelimit-remaining": "42",
        "x-ratelimit-limit": "100",
      },
    };

    cache.recordResult("svc", result);

    // Give the async write a tick to complete before we read status.
    return cache.fullStatus().then((status) => {
      expect(status["svc"]).toBeDefined();
      expect(status["svc"]!.remaining).toBe(42);
      expect(status["svc"]!.limit).toBe(100);
      expect(status["svc"]!.source).toBe("headers");
      expect(status["svc"]!.score).toBeCloseTo(0.42, 8);
    });
  });

  it("does nothing when there are no headers and not rate-limited", () => {
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: tmpFile() },
    );
    const result: DispatchResult = {
      output: "",
      service: "svc",
      success: true,
    };
    cache.recordResult("svc", result);

    return cache.fullStatus().then((status) => {
      expect(status["svc"]!.remaining).toBeNull();
      expect(status["svc"]!.limit).toBeNull();
      expect(status["svc"]!.source).toBe("unknown");
    });
  });
});

// ---------------------------------------------------------------------------
// QuotaCache._maybeRefresh — TTL is respected
// ---------------------------------------------------------------------------

describe("QuotaCache TTL-based refresh", () => {
  it("does not invoke checkQuota a second time within the TTL window", async () => {
    const checkQuota = vi.fn(
      async (): Promise<QuotaInfo> => ({
        service: "svc",
        remaining: 10,
        limit: 20,
        source: "api",
      }),
    );
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc", checkQuota) },
      { stateFile: tmpFile(), ttlMs: 10_000 }, // 10 seconds
    );

    const first = await cache.getQuotaScore("svc");
    const second = await cache.getQuotaScore("svc");

    expect(checkQuota).toHaveBeenCalledTimes(1);
    expect(first).toBeCloseTo(0.5, 8);
    expect(second).toBeCloseTo(0.5, 8);
  });

  it("returns score 1.0 when dispatcher is unknown", async () => {
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: tmpFile() },
    );
    const score = await cache.getQuotaScore("nonexistent");
    expect(score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Local-counts persistence
// ---------------------------------------------------------------------------

describe("QuotaCache local call counts", () => {
  it("persists local call counts to the state file and reloads them", async () => {
    const file = tmpFile();

    const cache1 = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: file },
    );
    const result: DispatchResult = {
      output: "",
      service: "svc",
      success: true,
    };
    cache1.recordResult("svc", result);
    cache1.recordResult("svc", result);
    cache1.recordResult("svc", result);

    // Force a synchronous flush — fire-and-forget async write may not have
    // completed yet.
    cache1.saveLocalCountsSync();

    // File should exist with the counts.
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, { local_calls?: number }>;
    expect(parsed["svc"]?.local_calls).toBe(3);

    // A fresh cache should load the persisted count and expose it via
    // fullStatus().localCallCount.
    const cache2 = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: file },
    );
    const status = await cache2.fullStatus();
    expect(status["svc"]!.localCallCount).toBe(3);
  });

  it("fullStatus reflects current in-memory counts", async () => {
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc"), other: makeDispatcher("other") },
      { stateFile: tmpFile() },
    );
    const result: DispatchResult = {
      output: "",
      service: "svc",
      success: true,
    };
    cache.recordResult("svc", result);
    cache.recordResult("svc", result);
    cache.recordResult("other", result);

    const status = await cache.fullStatus();
    expect(status["svc"]!.localCallCount).toBe(2);
    expect(status["other"]!.localCallCount).toBe(1);
  });

  it("loads existing state file on construction", async () => {
    const file = tmpFile();
    writeFileSync(
      file,
      JSON.stringify({ svc: { local_calls: 7 } }, null, 2),
      "utf-8",
    );
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: file },
    );
    const status = await cache.fullStatus();
    expect(status["svc"]!.localCallCount).toBe(7);
  });

  it("tolerates a malformed state file", async () => {
    const file = tmpFile();
    writeFileSync(file, "{not valid json", "utf-8");
    const cache = new QuotaCache(
      { svc: makeDispatcher("svc") },
      { stateFile: file },
    );
    const status = await cache.fullStatus();
    expect(status["svc"]!.localCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getQuotaInfo
// ---------------------------------------------------------------------------

describe("QuotaCache.getQuotaInfo", () => {
  it("returns a QuotaInfo snapshot with current state", async () => {
    const cache = new QuotaCache(
      {
        svc: makeDispatcher("svc", async () => ({
          service: "svc",
          remaining: 80,
          limit: 100,
          source: "api",
        })),
      },
      { stateFile: tmpFile() },
    );
    const info = await cache.getQuotaInfo("svc");
    expect(info).not.toBeNull();
    expect(info?.remaining).toBe(80);
    expect(info?.limit).toBe(100);
    expect(info?.source).toBe("api");
  });
});
