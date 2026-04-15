/**
 * Unit tests for the live-dashboard renderer.
 *
 * The renderer is a pure function — given a fixture state, its output is
 * deterministic. We snapshot key strings rather than raw bytes so the
 * tests stay readable if the format is tweaked.
 */

import { describe, it, expect } from "vitest";
import { renderDashboard, type DashboardState } from "../../src/dashboard/live.js";
import type { ServiceConfig } from "../../src/types.js";

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

function fixtureState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    services: [
      { name: "claude_code", config: svc("claude_code", { command: "claude" }), reachable: true },
      {
        name: "local_llm",
        config: svc("local_llm", {
          type: "openai_compatible",
          baseUrl: "http://localhost:11434/v1",
          tier: 3,
        }),
        reachable: true,
      },
    ],
    quotas: {
      claude_code: { score: 1.0, remaining: 80, limit: 100, localCallCount: 3 },
      local_llm: { score: 1.0, localCallCount: 0 },
    },
    breakers: {
      claude_code: { tripped: false, failures: 0 },
      local_llm: { tripped: true, failures: 3, cooldownRemainingSec: 45 },
    },
    recentEvents: [],
    generatedAt: 1_700_000_000_000,
    ansi: false,
    ...overrides,
  };
}

describe("renderDashboard", () => {
  it("renders a plain-text snapshot", () => {
    const output = renderDashboard(fixtureState());
    expect(output).toContain("coding-agent-mcp — live dashboard");
    expect(output).toContain("CLAUDE_CODE");
    expect(output).toContain("LOCAL_LLM");
    expect(output).toContain("Tier 1 — Frontier");
    expect(output).toContain("Tier 3 — Fast/Local");
    expect(output).toContain("breaker: OPEN — 45s until reset");
    expect(output).toContain("Ready to route: claude_code, local_llm");
  });

  it("includes a quota bar with percentage when remaining/limit are set", () => {
    const output = renderDashboard(fixtureState());
    // 80/100 = 80% → 16 filled blocks, 4 empty (each block == 5%).
    expect(output).toMatch(/quota:\s*\[█{16}░{4}\]\s*80%/);
  });

  it("switches to 'assumed available' when no remaining/limit", () => {
    const state = fixtureState();
    state.quotas["local_llm"] = { score: 0.5 };
    const output = renderDashboard(state);
    expect(output).toContain("quota: 50% assumed available");
  });

  it("emits ANSI escape codes when ansi=true", () => {
    const output = renderDashboard(fixtureState({ ansi: true }));
    // CLEAR_SCREEN + HOME at the top.
    expect(output.startsWith("\u001b[2J\u001b[H")).toBe(true);
    // Success icon is green ✓ wrapped in escape codes.
    expect(output).toContain("\u001b[32m✓\u001b[0m");
  });

  it("renders recent events with severity colors when ansi=true", () => {
    const state = fixtureState({
      ansi: true,
      recentEvents: [
        {
          kind: "error",
          service: "claude_code",
          at: 1_699_999_999_000,
          message: "oom",
        },
      ],
    });
    const output = renderDashboard(state);
    expect(output).toContain("Recent Activity");
    expect(output).toContain("\u001b[31m[error]\u001b[0m");
  });

  it("reports 'none' when no services are ready", () => {
    const state = fixtureState();
    for (const s of state.services) s.reachable = false;
    const output = renderDashboard(state);
    expect(output).toContain("Ready to route: none");
  });

  it("truncates long recent-event messages", () => {
    const longMsg = "x".repeat(200);
    const state = fixtureState({
      recentEvents: [
        {
          kind: "stdout",
          service: "claude_code",
          at: 1_699_999_999_000,
          message: longMsg,
        },
      ],
    });
    const output = renderDashboard(state);
    expect(output).toContain("xxx...");
    // Original 200-char line is not present verbatim.
    expect(output.includes(longMsg)).toBe(false);
  });
});
