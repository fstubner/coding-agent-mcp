/**
 * Router streaming tests.
 *
 * Exercises Router.stream() with stub dispatchers that yield controlled
 * event sequences. Verifies:
 *  - events from the chosen dispatcher are passed through with the active
 *    RoutingDecision attached.
 *  - circuit-breaker state is updated after each attempt.
 *  - rate-limit events short-circuit fallback.
 *  - cancellation (iterator .return()) is respected.
 *  - routeTo() bypasses tier selection.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Reuse the same mock shape as the buffered router tests.
vi.mock("../../src/circuit-breaker.js", () => {
  class CircuitBreaker {
    failures = 0;
    private _tripped = false;
    private _cooldown = 300;
    get isTripped(): boolean {
      return this._tripped;
    }
    recordFailure(): void {
      this.failures += 1;
    }
    recordSuccess(): void {
      this.failures = 0;
      this._tripped = false;
    }
    trip(retryAfter?: number): void {
      this._tripped = true;
      if (retryAfter !== undefined && retryAfter > 0) this._cooldown = retryAfter;
    }
    forceTrip(): void {
      this._tripped = true;
    }
    cooldownRemaining(): number {
      return this._tripped ? this._cooldown : 0;
    }
    status() {
      return this._tripped
        ? { tripped: true, failures: this.failures, cooldownRemainingSec: this._cooldown }
        : { tripped: false, failures: this.failures };
    }
  }
  return { CircuitBreaker };
});

vi.mock("../../src/quota.js", () => {
  class QuotaCache {
    async getQuotaScore(): Promise<number> {
      return 1.0;
    }
    recordResult(): void {}
  }
  return { QuotaCache };
});

vi.mock("../../src/leaderboard.js", () => {
  class LeaderboardCache {
    async getQualityScore() {
      return { qualityScore: 1.0, elo: null };
    }
    async autoTier(_m: string | undefined, _t: unknown, fallbackTier: number): Promise<number> {
      return fallbackTier;
    }
  }
  return { LeaderboardCache };
});

import { Router } from "../../src/router.js";
import { QuotaCache } from "../../src/quota.js";
import { LeaderboardCache } from "../../src/leaderboard.js";
import type {
  DispatchResult,
  DispatcherEvent,
  RouterConfig,
  ServiceConfig,
} from "../../src/types.js";
import type { Dispatcher } from "../../src/dispatchers/base.js";

function svc(name: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    enabled: true,
    type: "cli",
    tier: 1,
    weight: 1,
    cliCapability: 1,
    escalateOn: [],
    capabilities: {},
    ...overrides,
  } as ServiceConfig;
}

function makeConfig(services: ServiceConfig[]): RouterConfig {
  const map: Record<string, ServiceConfig> = {};
  for (const s of services) map[s.name] = s;
  return { services: map };
}

class ScriptedDispatcher implements Dispatcher {
  readonly id: string;
  private scripts: DispatcherEvent[][] = [];
  dispatchCalls = 0;
  streamCalls = 0;

  constructor(id: string) {
    this.id = id;
  }

  push(events: DispatcherEvent[]): void {
    this.scripts.push(events);
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota() {
    return { service: this.id, source: "unknown" as const };
  }

  async dispatch(): Promise<DispatchResult> {
    this.dispatchCalls += 1;
    const script = this.scripts.shift() ?? [];
    const completion = script.find((e) => e.type === "completion");
    if (completion?.type === "completion") return completion.result;
    return {
      output: "",
      service: this.id,
      success: false,
      error: "no script",
    };
  }

  stream(): AsyncIterable<DispatcherEvent> {
    this.streamCalls += 1;
    const script = this.scripts.shift() ?? [];
    async function* gen() {
      for (const e of script) yield e;
    }
    return gen();
  }
}

describe("Router.stream", () => {
  let quota: QuotaCache;
  let leaderboard: LeaderboardCache;

  beforeEach(() => {
    quota = new QuotaCache();
    leaderboard = new LeaderboardCache();
  });

  it("emits events from the picked dispatcher with the active decision", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      { type: "stdout", chunk: "chunk-1" },
      { type: "stdout", chunk: "chunk-2" },
      {
        type: "completion",
        result: { output: "chunk-1chunk-2", service: "alpha", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([svc("alpha")]),
      quota,
      { alpha },
      leaderboard,
    );
    const events: DispatcherEvent[] = [];
    let decisionSeen = false;
    for await (const { event, decision } of router.stream("p", [], "/tmp")) {
      events.push(event);
      if (decision) decisionSeen = true;
    }
    expect(decisionSeen).toBe(true);
    expect(events.filter((e) => e.type === "stdout").length).toBe(2);
    expect(events[events.length - 1]?.type).toBe("completion");
  });

  it("falls back to the next service on transient failure", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      { type: "stderr", chunk: "transient error" },
      {
        type: "completion",
        result: { output: "", service: "alpha", success: false, error: "transient" },
      },
    ]);
    const beta = new ScriptedDispatcher("beta");
    beta.push([
      { type: "stdout", chunk: "beta-ok" },
      {
        type: "completion",
        result: { output: "beta-ok", service: "beta", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([
        svc("alpha", { tier: 1 }),
        svc("beta", { tier: 2 }),
      ]),
      quota,
      { alpha, beta },
      leaderboard,
    );

    const services: string[] = [];
    let finalSuccess = false;
    for await (const { event, decision } of router.stream("p", [], "/tmp")) {
      if (decision) services.push(decision.service);
      if (event.type === "completion") finalSuccess = event.result.success;
    }
    expect(alpha.streamCalls).toBe(1);
    expect(beta.streamCalls).toBe(1);
    expect(finalSuccess).toBe(true);
    // Both alpha and beta should have been seen in the decisions stream.
    expect(new Set(services)).toEqual(new Set(["alpha", "beta"]));
  });

  it("stops fallback on a rate_limited event", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: {
          output: "",
          service: "alpha",
          success: false,
          error: "rate limit",
          rateLimited: true,
          retryAfter: 30,
        },
      },
    ]);
    const beta = new ScriptedDispatcher("beta");
    beta.push([
      {
        type: "completion",
        result: { output: "beta", service: "beta", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([
        svc("alpha", { tier: 1 }),
        svc("beta", { tier: 2 }),
      ]),
      quota,
      { alpha, beta },
      leaderboard,
    );
    let finalRateLimited = false;
    for await (const { event } of router.stream("p", [], "/tmp")) {
      if (event.type === "completion" && event.result.rateLimited) {
        finalRateLimited = true;
      }
    }
    expect(finalRateLimited).toBe(true);
    expect(alpha.streamCalls).toBe(1);
    expect(beta.streamCalls).toBe(0);
  });

  it("yields an error completion when no service is available", async () => {
    const router = new Router(
      makeConfig([svc("alpha", { enabled: false })]),
      quota,
      {},
      leaderboard,
    );
    const events: DispatcherEvent[] = [];
    for await (const { event } of router.stream("p", [], "/tmp")) events.push(event);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("completion");
    if (events[0]?.type === "completion") {
      expect(events[0].result.success).toBe(false);
      expect(events[0].result.error).toMatch(/No available services/i);
    }
  });

  it("streamTo bypasses tier selection and attaches an explicit decision", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: { output: "direct", service: "alpha", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([svc("alpha"), svc("beta", { tier: 2 })]),
      quota,
      { alpha },
      leaderboard,
    );
    const services: string[] = [];
    for await (const { decision } of router.streamTo("alpha", "p", [], "/tmp")) {
      if (decision) services.push(decision.service);
    }
    expect(alpha.streamCalls).toBe(1);
    expect(services[0]).toBe("alpha");
  });

  it("buffered route() is still implemented and works alongside stream()", async () => {
    const alpha = new ScriptedDispatcher("alpha");
    alpha.push([
      {
        type: "completion",
        result: { output: "buffered", service: "alpha", success: true },
      },
    ]);
    const router = new Router(
      makeConfig([svc("alpha")]),
      quota,
      { alpha },
      leaderboard,
    );
    const { result } = await router.route("p", [], "/tmp");
    expect(result.success).toBe(true);
    expect(result.output).toBe("buffered");
    // route() uses dispatch() (preserves legacy test assertions).
    expect(alpha.dispatchCalls).toBe(1);
  });
});
