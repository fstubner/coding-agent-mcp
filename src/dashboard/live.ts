/**
 * Live dashboard renderer for coding-agent-mcp.
 *
 * Pure function `renderDashboard(state)` → ANSI-formatted string. Consumed
 * by:
 *   - The `dashboard` MCP tool (one-shot snapshot, no ANSI codes unless the
 *     caller asks for them).
 *   - `bin.ts dashboard --watch` (live-redraw loop — prints ANSI codes
 *     when the output is a TTY).
 *
 * Keeping the renderer pure (no I/O) makes it unit-testable with a simple
 * snapshot-style assertion.
 */

import type { ServiceConfig } from "../types.js";

export interface BreakerState {
  tripped: boolean;
  failures: number;
  cooldownRemainingSec?: number;
}

export interface QuotaState {
  score: number;
  remaining?: number | null;
  limit?: number | null;
  localCallCount?: number;
  resetAt?: string;
}

export interface RecentEvent {
  kind: "stdout" | "stderr" | "tool_use" | "thinking" | "completion" | "error";
  service: string;
  at: number; // epoch ms
  message: string;
}

export interface DashboardState {
  services: Array<{ name: string; config: ServiceConfig; reachable: boolean }>;
  quotas: Record<string, QuotaState | undefined>;
  breakers: Record<string, BreakerState | undefined>;
  recentEvents: RecentEvent[];
  /** Optional "last refreshed at" timestamp. */
  generatedAt?: number;
  /** If true, the renderer will emit ANSI cursor codes (clear screen + home). */
  ansi?: boolean;
}

const CLEAR_SCREEN = "\u001b[2J\u001b[H"; // clear + home
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function statusIcon(enabled: boolean, reachable: boolean, ansi: boolean): string {
  const ok = enabled && reachable;
  if (!ansi) return ok ? "[ok]" : "[--]";
  return ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}

function breakerLine(state: BreakerState | undefined, ansi: boolean): string {
  if (!state) return "breaker: closed";
  if (state.tripped) {
    const cd = state.cooldownRemainingSec ?? 0;
    const msg = `breaker: OPEN — ${Math.round(cd)}s until reset`;
    return ansi ? `${YELLOW}${msg}${RESET}` : msg;
  }
  return `breaker: closed (${state.failures} recent failures)`;
}

function quotaLine(q: QuotaState | undefined, ansi: boolean): string {
  if (!q) return "quota: unknown";
  if (q.remaining != null && q.limit != null && q.limit > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((q.remaining / q.limit) * 100)));
    const filled = Math.round(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, 20 - filled));
    const color = ansi ? (pct < 25 ? RED : pct < 60 ? YELLOW : GREEN) : "";
    const reset = ansi ? RESET : "";
    return `quota: ${color}[${bar}] ${pct}%${reset}  (${q.remaining}/${q.limit})`;
  }
  const pct = Math.round(q.score * 100);
  return `quota: ${pct}% assumed available`;
}

function formatTimeAgo(now: number, at: number): string {
  const diff = Math.max(0, now - at);
  if (diff < 1000) return `${diff}ms ago`;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

/**
 * Render a dashboard snapshot. Deterministic for a given state.
 */
export function renderDashboard(state: DashboardState): string {
  const ansi = state.ansi === true;
  const now = state.generatedAt ?? Date.now();
  const out: string[] = [];

  if (ansi) out.push(CLEAR_SCREEN);

  // Header
  if (ansi) out.push(`${BOLD}coding-agent-mcp — live dashboard${RESET}`);
  else out.push("coding-agent-mcp — live dashboard");
  out.push(
    ansi
      ? `${DIM}refreshed ${new Date(now).toISOString()}${RESET}`
      : `refreshed ${new Date(now).toISOString()}`,
  );
  out.push("");

  // Group services by tier
  const byTier: Map<number, typeof state.services> = new Map();
  for (const svcEntry of state.services) {
    const tier = svcEntry.config.tier;
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(svcEntry);
    else byTier.set(tier, [svcEntry]);
  }

  const tierLabels: Record<number, string> = {
    1: "Tier 1 — Frontier",
    2: "Tier 2 — Strong",
    3: "Tier 3 — Fast/Local",
  };

  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const label = tierLabels[tier] ?? `Tier ${tier}`;
    out.push(`── ${label} ──────────────────────────────`);
    out.push("");
    for (const svcEntry of byTier.get(tier)!) {
      const { name, config: svc, reachable } = svcEntry;
      out.push(`  ${statusIcon(svc.enabled, reachable, ansi)} ${name.toUpperCase()}`);
      if (svc.type === "openai_compatible") {
        out.push(`      connection : HTTP API  ${svc.baseUrl ?? "(no base_url)"}`);
      } else {
        out.push(`      connection : ${svc.command ?? "(no command)"}`);
      }
      out.push(
        `      limits     : output-cap ${fmtTokens(svc.maxOutputTokens)}, context ${fmtTokens(svc.maxInputTokens)}`,
      );
      out.push(`      ${quotaLine(state.quotas[name], ansi)}`);
      out.push(`      ${breakerLine(state.breakers[name], ansi)}`);
      const calls = state.quotas[name]?.localCallCount ?? 0;
      out.push(`      calls      : ${calls} this session`);
      if (!svc.enabled) out.push("      note       : disabled in config");
      out.push("");
    }
  }

  // Recent events
  if (state.recentEvents.length > 0) {
    out.push("── Recent Activity ──────────────────────────");
    out.push("");
    for (const evt of state.recentEvents.slice(-8)) {
      const color = ansi
        ? evt.kind === "error"
          ? RED
          : evt.kind === "completion"
            ? GREEN
            : DIM
        : "";
      const reset = ansi ? RESET : "";
      const ago = formatTimeAgo(now, evt.at);
      const msg = evt.message.length > 80 ? `${evt.message.slice(0, 77)}...` : evt.message;
      out.push(`  ${color}[${evt.kind}]${reset} ${evt.service}: ${msg}  (${ago})`);
    }
    out.push("");
  }

  const ready = state.services
    .filter((s) => s.config.enabled && s.reachable)
    .map((s) => s.name);
  out.push(`Ready to route: ${ready.length === 0 ? "none" : ready.join(", ")}`);

  return out.join("\n");
}
