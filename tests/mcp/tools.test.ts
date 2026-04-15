/**
 * Unit tests for the MCP tool handlers.
 *
 * These tests bypass MCP transport entirely — they call `invokeTool()`
 * directly with mocked router / quota / dispatcher state. Each of the 10
 * tools is exercised against an in-memory holder so the test is fast and
 * deterministic (no real subprocesses, no real HTTP).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// The tools import from ../config-hot-reload.js which depends on the real
// Router, QuotaCache, etc. We keep those modules real (they are unit-tested
// elsewhere) and only mock the leaderboard HTTP fetch at runtime.

import { invokeTool, TOOL_NAMES } from "../../src/mcp/tools.js";
import { RuntimeHolder, type RuntimeState } from "../../src/mcp/config-hot-reload.js";
import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { LeaderboardCache } from "../../src/leaderboard.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";
import type {
  DispatchResult,
  QuotaInfo,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDispatcher implements Dispatcher {
  readonly id: string;
  constructor(
    id: string,
    private readonly response: DispatchResult = {
      output: "hello",
      service: id,
      success: true,
    },
    private readonly available = true,
  ) {
    this.id = id;
  }
  async dispatch(): Promise<DispatchResult> {
    return this.response;
  }
  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }
  isAvailable(): boolean {
    return this.available;
  }
}

function makeService(
  name: string,
  over: Partial<ServiceConfig> = {},
): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    harness: name,
    command: name,
    tier: 1,
    weight: 1.0,
    cliCapability: 1.0,
    capabilities: { execute: 1.0, plan: 1.0, review: 1.0 },
    escalateOn: [],
    leaderboardModel: `${name}-model`,
    maxOutputTokens: 64_000,
    maxInputTokens: 1_000_000,
    ...over,
  };
}

// Build a minimal runtime holder with N fake services.
function buildHolder(services: Record<string, ServiceConfig>, dispatchers: Record<string, Dispatcher>): RuntimeHolder {
  const config: RouterConfig = { services };
  const quota = new QuotaCache(dispatchers, { stateFile: ":memory-not-used:" });
  // Prevent real leaderboard fetches — stub the class at the instance level.
  const leaderboard = new LeaderboardCache();
  // Force the cache into a fetched state so no network call happens.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (leaderboard as any).fetchedAt = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (leaderboard as any).data = {
    "claude-opus-4-6": 1500,
    "gpt-5.4": 1400,
    "gemini-3.1-pro-preview": 1380,
    "claude-sonnet-4-6": 1420,
    "a-model": 1500,
    "b-model": 1400,
    "c-model": 1300,
  };
  const router = new Router(config, quota, dispatchers, leaderboard);
  const state: RuntimeState = {
    config,
    dispatchers,
    quota,
    router,
    leaderboard,
    mtimeMs: 0,
  };
  return new RuntimeHolder(state);
}

// Silence QuotaCache's on-disk writes by pointing at a sandbox path.
beforeEach(() => {
  vi.spyOn(QuotaCache.prototype, "saveLocalCountsSync").mockImplementation(
    () => undefined,
  );
});

// ---------------------------------------------------------------------------
// Individual tool tests
// ---------------------------------------------------------------------------

describe("MCP tools — TOOL_NAMES", () => {
  it("exports exactly the 10 required tool names", () => {
    expect(TOOL_NAMES).toHaveLength(10);
    expect(new Set(TOOL_NAMES)).toEqual(
      new Set([
        "code_with_claude",
        "code_with_cursor",
        "code_with_codex",
        "code_with_gemini",
        "code_auto",
        "code_mixture",
        "get_quota_status",
        "list_available_services",
        "dashboard",
        "setup",
      ]),
    );
  });
});

describe("MCP tools — code_with_<harness>", () => {
  it.each([
    ["code_with_claude", "claude_code"],
    ["code_with_codex", "codex"],
    ["code_with_cursor", "cursor"],
    ["code_with_gemini", "gemini_cli"],
  ])("%s routes to the matching harness", async (tool, harness) => {
    const services = {
      alpha: makeService("alpha", { harness }),
      beta: makeService("beta", { harness: "other" }), // should not be picked
    };
    const dispatchers: Record<string, Dispatcher> = {
      alpha: new FakeDispatcher("alpha", { output: `from ${harness}`, service: "alpha", success: true }),
      beta: new FakeDispatcher("beta", { output: "wrong", service: "beta", success: true }),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool(
      tool,
      { prompt: "hi" },
      { holder },
    );
    expect(r.kind).toBe("json");
    const data = r.data as { service: string; success: boolean; output: string };
    expect(data.service).toBe("alpha");
    expect(data.success).toBe(true);
    expect(data.output).toContain(harness);
  });
});

describe("MCP tools — code_auto", () => {
  it("routes successfully and returns a routing block", async () => {
    const services = {
      a: makeService("a", { tier: 1, leaderboardModel: "a-model" }),
      b: makeService("b", { tier: 2, leaderboardModel: "b-model" }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "from a", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "from b", service: "b", success: true }),
    };
    const holder = buildHolder(services, dispatchers);

    const r = await invokeTool(
      "code_auto",
      { prompt: "hi", hints: { taskType: "plan" } },
      { holder },
    );
    expect(r.kind).toBe("json");
    const data = r.data as {
      success: boolean;
      service: string;
      routing?: { tier: number; reason: string; finalScore: number };
    };
    expect(data.success).toBe(true);
    // Tier 1 (service `a`) has the higher-ELO model (1500 vs 1400).
    expect(data.service).toBe("a");
    expect(data.routing).toBeDefined();
    expect(data.routing!.tier).toBe(1);
    expect(data.routing!.finalScore).toBeGreaterThan(0);
  });

  it("returns success=false when every service is unavailable", async () => {
    const services = {
      a: makeService("a"),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "nope", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("code_auto", { prompt: "hi" }, { holder });
    const data = r.data as { success: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(typeof data.error).toBe("string");
  });
});

describe("MCP tools — code_mixture", () => {
  it("fans out to all available services in parallel", async () => {
    const services = {
      a: makeService("a", { capabilities: { execute: 0.9, plan: 0.95, review: 0.9 } }),
      b: makeService("b", { capabilities: { execute: 1.0, plan: 0.8, review: 0.7 } }),
      c: makeService("c", { capabilities: { execute: 0.8, plan: 0.85, review: 0.95 } }),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "A", service: "a", success: true }),
      b: new FakeDispatcher("b", { output: "B", service: "b", success: true }),
      c: new FakeDispatcher("c", { output: "C", service: "c", success: true }),
    };
    const holder = buildHolder(services, dispatchers);

    const r = await invokeTool(
      "code_mixture",
      { prompt: "hi", hints: { taskType: "plan" } },
      { holder },
    );
    expect(r.kind).toBe("json");
    const data = r.data as { results: Array<{ service: string; success: boolean; output: string }> };
    expect(data.results).toHaveLength(3);
    for (const item of data.results) {
      expect(item.success).toBe(true);
      expect(["A", "B", "C"]).toContain(item.output);
    }
    // Sorted by capability DESC — `a` (plan=0.95) should come first.
    expect(data.results[0]!.service).toBe("a");
  });

  it("honours the explicit services whitelist", async () => {
    const services = {
      a: makeService("a"),
      b: makeService("b"),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a"),
      b: new FakeDispatcher("b"),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool(
      "code_mixture",
      { prompt: "hi", services: ["b"] },
      { holder },
    );
    const data = r.data as { results: Array<{ service: string }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.service).toBe("b");
  });

  it("returns an empty results array when nothing is available", async () => {
    const services = {
      a: makeService("a"),
    };
    const dispatchers: Record<string, Dispatcher> = {
      a: new FakeDispatcher("a", { output: "", service: "a", success: true }, false),
    };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("code_mixture", { prompt: "hi" }, { holder });
    const data = r.data as { results: unknown[] };
    expect(data.results).toEqual([]);
  });
});

describe("MCP tools — introspection", () => {
  it("get_quota_status returns combined quota + breaker state per service", async () => {
    const services = { a: makeService("a") };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("get_quota_status", {}, { holder });
    expect(r.kind).toBe("json");
    const data = r.data as Record<string, { circuitBreaker: { tripped: boolean } }>;
    expect(data.a).toBeDefined();
    expect(data.a!.circuitBreaker).toEqual({ tripped: false, failures: 0 });
  });

  it("list_available_services surfaces maxOutputTokens / maxInputTokens", async () => {
    const services = {
      a: makeService("a", { maxOutputTokens: 100_000, maxInputTokens: 2_000_000 }),
    };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("list_available_services", {}, { holder });
    const data = r.data as {
      services: Array<{
        name: string;
        reachable: boolean;
        maxOutputTokens?: number;
        maxInputTokens?: number;
      }>;
    };
    expect(data.services).toHaveLength(1);
    expect(data.services[0]!.name).toBe("a");
    expect(data.services[0]!.reachable).toBe(true);
    expect(data.services[0]!.maxOutputTokens).toBe(100_000);
    expect(data.services[0]!.maxInputTokens).toBe(2_000_000);
  });

  it("dashboard returns multi-line text including token limits", async () => {
    const services = {
      a: makeService("a", { maxOutputTokens: 64_000, maxInputTokens: 1_000_000 }),
    };
    const dispatchers: Record<string, Dispatcher> = { a: new FakeDispatcher("a") };
    const holder = buildHolder(services, dispatchers);
    const r = await invokeTool("dashboard", {}, { holder });
    expect(r.kind).toBe("text");
    const text = r.data as string;
    expect(text).toContain("coding-agent-mcp");
    // Token-cap line appears in the dashboard body.
    expect(text).toMatch(/output-cap/);
    expect(text).toMatch(/context/);
  });
});

describe("MCP tools — setup", () => {
  it("returns a textual summary of what it wrote", async () => {
    const holder = buildHolder({}, {});
    // Sandbox HOMEDIR so the test doesn't touch the real ~/.claude.
    const { tmpdir } = await import("node:os");
    const tmp = tmpdir();
    const { mkdtempSync } = await import("node:fs");
    const fake = mkdtempSync(`${tmp}/coding-agent-mcp-test-`);
    const prev = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fake;
    process.env.USERPROFILE = fake;
    try {
      const r = await invokeTool(
        "setup",
        { writeClaudeMd: true, writeSessionHook: true },
        { holder },
      );
      expect(r.kind).toBe("text");
      const text = r.data as string;
      expect(text).toContain("CLAUDE.md");
      expect(text).toContain("hooks.json");
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
      else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("honours writeClaudeMd=false / writeSessionHook=false", async () => {
    const holder = buildHolder({}, {});
    const r = await invokeTool(
      "setup",
      { writeClaudeMd: false, writeSessionHook: false },
      { holder },
    );
    const text = r.data as string;
    expect(text).toContain("skipped (writeClaudeMd=false)");
    expect(text).toContain("skipped (writeSessionHook=false)");
  });
});
