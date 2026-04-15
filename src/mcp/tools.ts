/**
 * Tool registry for the coding-agent-mcp server.
 *
 * Each tool here is defined as a plain object with a name, description, zod
 * input schema, and an async handler. `registerTools()` attaches them all to
 * an `McpServer` instance. `invokeTool()` is the direct-call entry point the
 * unit tests use — it bypasses MCP transport entirely.
 *
 * R3: code_with_*, code_auto, and code_mixture tools stream via the MCP
 * `notifications/progress` protocol. When the caller sets `_meta.progressToken`
 * on the request, each stdout chunk / tool_use / thinking event fires a
 * progress notification; the final return value is still the buffered result
 * the R2 tests expect. Static tools (dashboard / list_available_services /
 * quota status / setup) don't stream.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { DispatchResult, DispatcherEvent, RouteHints, TaskType } from "../types.js";
import { withMcpToolSpan } from "../observability/spans.js";
import type { RuntimeHolder } from "./config-hot-reload.js";
import type { ConfigHotReloader } from "./config-hot-reload.js";

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

const taskTypeSchema = z.enum(["execute", "plan", "review", "local"]);

const routeHintsSchema = z
  .object({
    service: z.string().optional().describe("Force a specific service by name."),
    harness: z
      .string()
      .optional()
      .describe("Restrict to one harness (claude_code | cursor | codex | gemini_cli)."),
    taskType: taskTypeSchema.optional().describe("execute | plan | review | local"),
    preferLargeContext: z
      .boolean()
      .optional()
      .describe("Extra boost for Gemini (1M+ token context)."),
  })
  .describe("Routing hints passed to the router.");

const routeInputShape = {
  prompt: z.string().describe("The coding task or question."),
  files: z
    .array(z.string())
    .optional()
    .describe("Absolute file paths to include as context."),
  workingDir: z
    .string()
    .optional()
    .describe("Working directory for the CLI process."),
  modelOverride: z
    .string()
    .optional()
    .describe("Force a specific model on the chosen dispatcher."),
  hints: routeHintsSchema.optional(),
} as const;

const autoInputShape = {
  prompt: z.string(),
  files: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  hints: routeHintsSchema.optional(),
} as const;

const mixtureInputShape = {
  prompt: z.string(),
  files: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  hints: routeHintsSchema.optional(),
  services: z
    .array(z.string())
    .optional()
    .describe("Optional subset of service names — defaults to all available."),
} as const;

const setupInputShape = {
  writeClaudeMd: z.boolean().optional(),
  writeSessionHook: z.boolean().optional(),
} as const;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface RouteResponse {
  success: boolean;
  output: string;
  error?: string;
  service: string;
  model?: string;
  durationMs?: number;
  tokensUsed?: { input: number; output: number };
  routing?: {
    tier: number;
    quotaScore: number;
    qualityScore: number;
    cliCapability: number;
    capabilityScore: number;
    taskType: TaskType;
    elo?: number;
    finalScore: number;
    reason: string;
  };
}

export interface MixtureItem {
  service: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  capabilityScore: number;
  qualityScore: number;
  elo?: number;
}

export interface ListedService {
  name: string;
  enabled: boolean;
  harness: string;
  tier: number;
  weight: number;
  cliCapability: number;
  leaderboardModel?: string;
  cliType: "cli" | "openai_compatible";
  command?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  reachable: boolean;
  quotaScore: number;
  circuitBreaker: { tripped: boolean; failures: number; cooldownRemainingSec?: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonText(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function plainText(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function toHints(h: z.infer<typeof routeHintsSchema> | undefined): RouteHints {
  if (!h) return {};
  const out: RouteHints = {};
  if (h.service !== undefined) out.service = h.service;
  if (h.harness !== undefined) out.harness = h.harness;
  if (h.taskType !== undefined) out.taskType = h.taskType;
  if (h.preferLargeContext !== undefined) out.preferLargeContext = h.preferLargeContext;
  return out;
}

function mergeHintsForHarness(
  base: z.infer<typeof routeHintsSchema> | undefined,
  harness: string,
): RouteHints {
  const h = toHints(base);
  h.harness = harness;
  return h;
}

async function ensureFreshConfig(reloader: ConfigHotReloader | undefined): Promise<void> {
  if (reloader) await reloader.maybeReload();
}

/**
 * Minimal shape of the `extra` arg passed to tool handlers by the SDK.
 * We only need `_meta.progressToken` and `sendNotification`.
 */
export interface ToolExtra {
  _meta?: { progressToken?: string | number } & Record<string, unknown>;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

/**
 * Emit a progress notification carrying the streaming `event`. The
 * receiver inspects `_meta.event` to reconstruct the DispatcherEvent.
 *
 * We encode the per-event payload in the notification's `message` (a short
 * human-readable summary) and attach the machine-readable event object under
 * `_meta.event`. The `progress` field monotonically increments so the client
 * can enforce in-order delivery.
 */
async function emitProgress(
  extra: ToolExtra | undefined,
  progressToken: string | number | undefined,
  counter: { value: number },
  event: DispatcherEvent,
  service?: string,
): Promise<void> {
  if (!extra?.sendNotification || progressToken === undefined) return;
  counter.value += 1;
  const message = summarizeEvent(event, service);
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: counter.value,
        message,
        _meta: { event, service },
      },
    });
  } catch {
    // Best-effort notifications. A misbehaving transport shouldn't crash the
    // tool call.
  }
}

function summarizeEvent(event: DispatcherEvent, service?: string): string {
  const prefix = service ? `[${service}] ` : "";
  switch (event.type) {
    case "stdout":
      return `${prefix}stdout: ${truncate(event.chunk, 60)}`;
    case "stderr":
      return `${prefix}stderr: ${truncate(event.chunk, 60)}`;
    case "tool_use":
      return `${prefix}tool_use: ${event.name}`;
    case "thinking":
      return `${prefix}thinking: ${truncate(event.chunk, 60)}`;
    case "completion":
      return `${prefix}completion: ${event.result.success ? "ok" : "fail"}`;
    case "error":
      return `${prefix}error: ${event.error}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

// ---------------------------------------------------------------------------
// Tool handlers — exported for direct use in unit tests
// ---------------------------------------------------------------------------

export interface ToolDeps {
  holder: RuntimeHolder;
  reloader?: ConfigHotReloader;
}

/**
 * Run a routed dispatch via streaming, with progress notifications on
 * every event, and shape the final result. Shared by code_auto + code_with_*.
 */
async function runRoutedStreaming(
  deps: ToolDeps,
  prompt: string,
  files: string[],
  workingDir: string,
  hints: RouteHints,
  maxFallbacks: number | undefined,
  extra: ToolExtra | undefined,
): Promise<RouteResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const progressToken = extra?._meta?.progressToken;
  const counter = { value: 0 };

  const opts: { hints: RouteHints; maxFallbacks?: number } = { hints };
  if (maxFallbacks !== undefined) opts.maxFallbacks = maxFallbacks;

  let finalResult: DispatchResult | null = null;
  let finalDecision: import("../types.js").RoutingDecision | null = null;

  for await (const { event, decision } of state.router.stream(prompt, files, workingDir, opts)) {
    if (decision) finalDecision = decision;
    await emitProgress(extra, progressToken, counter, event, decision?.service);
    if (event.type === "completion") finalResult = event.result;
  }

  const result: DispatchResult =
    finalResult ??
    ({
      output: "",
      service: "none",
      success: false,
      error: "Router stream ended without a completion event",
    } as DispatchResult);

  const response: RouteResponse = {
    success: result.success,
    output: result.output,
    service: result.service,
  };
  if (result.error !== undefined) response.error = result.error;
  if (result.durationMs !== undefined) response.durationMs = result.durationMs;
  if (result.tokensUsed !== undefined) response.tokensUsed = result.tokensUsed;
  if (finalDecision) {
    if (finalDecision.model !== undefined) response.model = finalDecision.model;
    response.routing = {
      tier: finalDecision.tier,
      quotaScore: finalDecision.quotaScore,
      qualityScore: finalDecision.qualityScore,
      cliCapability: finalDecision.cliCapability,
      capabilityScore: finalDecision.capabilityScore,
      taskType: finalDecision.taskType,
      finalScore: finalDecision.finalScore,
      reason: finalDecision.reason,
      ...(finalDecision.elo !== undefined ? { elo: finalDecision.elo } : {}),
    };
  }
  return response;
}

/**
 * Buffered fallback used by the (non-streaming) test-invocation path. Still
 * goes through the router — just uses route() instead of stream() so the
 * existing mocks that assert dispatcher.dispatch was called once don't
 * break.
 */
async function runRoutedBuffered(
  deps: ToolDeps,
  prompt: string,
  files: string[],
  workingDir: string,
  hints: RouteHints,
  maxFallbacks?: number,
): Promise<RouteResponse> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const opts: { hints: RouteHints; maxFallbacks?: number } = { hints };
  if (maxFallbacks !== undefined) opts.maxFallbacks = maxFallbacks;
  const { result, decision } = await state.router.route(prompt, files, workingDir, opts);

  const response: RouteResponse = {
    success: result.success,
    output: result.output,
    service: result.service,
  };
  if (result.error !== undefined) response.error = result.error;
  if (result.durationMs !== undefined) response.durationMs = result.durationMs;
  if (result.tokensUsed !== undefined) response.tokensUsed = result.tokensUsed;
  if (decision) {
    if (decision.model !== undefined) response.model = decision.model;
    response.routing = {
      tier: decision.tier,
      quotaScore: decision.quotaScore,
      qualityScore: decision.qualityScore,
      cliCapability: decision.cliCapability,
      capabilityScore: decision.capabilityScore,
      taskType: decision.taskType,
      finalScore: decision.finalScore,
      reason: decision.reason,
      ...(decision.elo !== undefined ? { elo: decision.elo } : {}),
    };
  }
  return response;
}

export async function handleCodeWithHarness(
  deps: ToolDeps,
  harness: string,
  input: z.infer<z.ZodObject<typeof routeInputShape>>,
  maxFallbacks: number,
  extra?: ToolExtra,
): Promise<RouteResponse> {
  const hints = mergeHintsForHarness(input.hints, harness);
  const progressToken = extra?._meta?.progressToken;
  const toolName = `code_with_${harness}`;
  return withMcpToolSpan({ "tool.name": toolName }, async () => {
    if (progressToken !== undefined) {
      return runRoutedStreaming(
        deps,
        input.prompt,
        input.files ?? [],
        input.workingDir ?? process.cwd(),
        hints,
        maxFallbacks,
        extra,
      );
    }
    return runRoutedBuffered(
      deps,
      input.prompt,
      input.files ?? [],
      input.workingDir ?? process.cwd(),
      hints,
      maxFallbacks,
    );
  });
}

export async function handleCodeAuto(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof autoInputShape>>,
  extra?: ToolExtra,
): Promise<RouteResponse> {
  const progressToken = extra?._meta?.progressToken;
  return withMcpToolSpan({ "tool.name": "code_auto" }, async () => {
    if (progressToken !== undefined) {
      return runRoutedStreaming(
        deps,
        input.prompt,
        input.files ?? [],
        input.workingDir ?? process.cwd(),
        toHints(input.hints),
        2,
        extra,
      );
    }
    return runRoutedBuffered(
      deps,
      input.prompt,
      input.files ?? [],
      input.workingDir ?? process.cwd(),
      toHints(input.hints),
      2,
    );
  });
}

export async function handleCodeMixture(
  deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof mixtureInputShape>>,
  extra?: ToolExtra,
): Promise<{ results: MixtureItem[] }> {
  return withMcpToolSpan({ "tool.name": "code_mixture" }, async () => {
    await ensureFreshConfig(deps.reloader);
    const state = deps.holder.state;
    const hints = toHints(input.hints);
    const taskType: TaskType = hints.taskType ?? "plan";
    const requested = new Set(input.services ?? []);
    const progressToken = extra?._meta?.progressToken;
    const counter = { value: 0 };

    const candidates: string[] = [];
    for (const [name, svc] of Object.entries(state.config.services)) {
      if (!svc.enabled) continue;
      if (!(name in state.dispatchers)) continue;
      if (requested.size > 0 && !requested.has(name)) continue;
      const breaker = state.router.getBreaker(name);
      if (breaker && breaker.isTripped) continue;
      const disp = state.dispatchers[name];
      if (!disp?.isAvailable()) continue;
      candidates.push(name);
    }

    if (candidates.length === 0) return { results: [] };

    const prompt = input.prompt;
    const files = input.files ?? [];
    const workingDir = input.workingDir ?? process.cwd();

    // When streaming is requested, fan out via router.streamTo and multiplex
    // events through the single progress token. When not streaming, use the
    // buffered routeTo (same as before).
    const outcomes = await Promise.all(
      candidates.map(async (svcName): Promise<MixtureItem> => {
        const svc = state.config.services[svcName]!;
        const cap = svc.capabilities[taskType as "execute" | "plan" | "review"] ?? 1.0;
        const { qualityScore, elo } = await state.leaderboard.getQualityScore(
          svc.leaderboardModel,
          svc.thinkingLevel,
        );
        const t0 = Date.now();
        let result: DispatchResult;
        if (progressToken !== undefined) {
          let capturedResult: DispatchResult | null = null;
          for await (const { event } of state.router.streamTo(
            svcName,
            prompt,
            files,
            workingDir,
          )) {
            await emitProgress(extra, progressToken, counter, event, svcName);
            if (event.type === "completion") capturedResult = event.result;
          }
          result = capturedResult ?? {
            output: "",
            service: svcName,
            success: false,
            error: "Stream ended without completion",
          };
        } else {
          const outcome = await state.router.routeTo(svcName, prompt, files, workingDir);
          result = outcome.result;
        }
        const duration = Date.now() - t0;
        const item: MixtureItem = {
          service: svcName,
          success: result.success,
          output: result.output,
          durationMs: duration,
          capabilityScore: cap,
          qualityScore,
        };
        if (result.error !== undefined) item.error = result.error;
        if (elo !== null) item.elo = elo;
        return item;
      }),
    );

    outcomes.sort((a, b) => {
      if (a.success !== b.success) return a.success ? -1 : 1;
      return b.capabilityScore - a.capabilityScore;
    });
    return { results: outcomes };
  });
}

export async function handleQuotaStatus(
  deps: ToolDeps,
): Promise<Record<string, unknown>> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const quota = await state.quota.fullStatus();
  const breakers = state.router.circuitBreakerStatus();
  const out: Record<string, unknown> = {};
  const names = new Set([...Object.keys(quota), ...Object.keys(breakers)]);
  for (const name of names) {
    out[name] = {
      ...(quota[name] ?? {}),
      circuitBreaker: breakers[name] ?? { tripped: false, failures: 0 },
    };
  }
  return out;
}

export async function handleListServices(
  deps: ToolDeps,
): Promise<{ services: ListedService[] }> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const breakers = state.router.circuitBreakerStatus();
  const out: ListedService[] = [];
  for (const [name, svc] of Object.entries(state.config.services)) {
    const dispatcher = state.dispatchers[name];
    const reachable = dispatcher?.isAvailable() ?? false;
    const quotaScore = await state.quota.getQuotaScore(name);
    const harness = svc.harness ?? name;
    const entry: ListedService = {
      name,
      enabled: svc.enabled,
      harness,
      tier: svc.tier,
      weight: svc.weight,
      cliCapability: svc.cliCapability,
      cliType: svc.type,
      reachable,
      quotaScore: Math.round(quotaScore * 1000) / 1000,
      circuitBreaker: breakers[name] ?? { tripped: false, failures: 0 },
    };
    if (svc.leaderboardModel !== undefined) entry.leaderboardModel = svc.leaderboardModel;
    if (svc.command !== undefined) entry.command = svc.command;
    if (svc.maxOutputTokens !== undefined) entry.maxOutputTokens = svc.maxOutputTokens;
    if (svc.maxInputTokens !== undefined) entry.maxInputTokens = svc.maxInputTokens;
    out.push(entry);
  }
  return { services: out };
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

export async function handleDashboard(deps: ToolDeps): Promise<string> {
  await ensureFreshConfig(deps.reloader);
  const state = deps.holder.state;
  const quota = await state.quota.fullStatus();
  const breakers = state.router.circuitBreakerStatus();

  const lines: string[] = [];
  lines.push("coding-agent-mcp — status dashboard", "");

  const lbAgeMs = state.leaderboard.cacheAgeMs();
  if (lbAgeMs === null) {
    lines.push("  leaderboard  : Arena Code ELO — not yet fetched (fetches on first route)");
  } else if (lbAgeMs < 3_600_000) {
    lines.push(`  leaderboard  : Arena Code ELO cache  (${Math.round(lbAgeMs / 60_000)}m old)`);
  } else {
    lines.push(
      `  leaderboard  : Arena Code ELO cache  (${(lbAgeMs / 3_600_000).toFixed(1)}h old — refreshes every 24h)`,
    );
  }
  if (state.leaderboard.benchmarkLoaded()) {
    lines.push("  benchmarks   : data/coding_benchmarks.json loaded");
  } else {
    lines.push("  benchmarks   : data/coding_benchmarks.json not found — using Arena ELO only");
  }
  lines.push("");

  const byTier: Map<number, string[]> = new Map();
  for (const name of Object.keys(state.config.services)) {
    const svc = state.config.services[name]!;
    const tier = svc.tier;
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(name);
    else byTier.set(tier, [name]);
  }

  const tierLabels: Record<number, string> = {
    1: "Tier 1 — Frontier",
    2: "Tier 2 — Strong",
    3: "Tier 3 — Fast/Local",
  };

  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    lines.push(`── ${tierLabels[tier] ?? `Tier ${tier}`} ──────────────────────────────`);
    lines.push("");
    for (const name of byTier.get(tier)!) {
      const svc = state.config.services[name]!;
      const dispatcher = state.dispatchers[name];
      const reachable = dispatcher?.isAvailable() ?? false;
      const icon = reachable && svc.enabled ? "✓" : "✗";
      lines.push(`  [${icon}] ${name.toUpperCase()}`);

      if (svc.type === "openai_compatible") {
        lines.push(`      connection : HTTP API  ${svc.baseUrl ?? "(no base_url)"}`);
      } else {
        const label = svc.command ? `${svc.command}` : "(no command)";
        lines.push(`      connection : ${label}`);
      }

      const { qualityScore, elo } = await state.leaderboard.getQualityScore(
        svc.leaderboardModel,
        svc.thinkingLevel,
      );
      const effective = qualityScore * svc.cliCapability;
      const cliPart = svc.cliCapability !== 1.0 ? ` × CLI ${svc.cliCapability.toFixed(2)}` : "";
      if (elo !== null) {
        lines.push(
          `      quality    : ELO ${elo.toFixed(0)}${cliPart} → ${(effective * 100).toFixed(0)}% effective`,
        );
      } else {
        lines.push(
          `      quality    : ELO unknown${cliPart} → ${(effective * 100).toFixed(0)}% effective`,
        );
      }

      lines.push(
        `      limits     : output-cap ${fmtTokens(svc.maxOutputTokens)}, context ${fmtTokens(svc.maxInputTokens)}`,
      );

      const q = quota[name];
      if (q && q.remaining !== null && q.limit !== null && q.limit > 0) {
        const pct = Math.round((q.remaining / q.limit) * 100);
        const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
        lines.push(`      quota      : [${bar}] ${pct}%  (${q.remaining}/${q.limit})`);
      } else {
        const pct = q ? Math.round(q.score * 100) : 100;
        lines.push(`      quota      : ${pct}% assumed available`);
      }
      const calls = q?.localCallCount ?? 0;
      lines.push(`      calls      : ${calls} this session`);

      const b = breakers[name];
      if (b?.tripped) {
        const cd = b.cooldownRemainingSec ?? 0;
        lines.push(`      breaker    : ⚡ OPEN — ${Math.round(cd)}s until reset`);
      } else {
        lines.push(`      breaker    : closed  (${b?.failures ?? 0} recent failures)`);
      }
      if (!svc.enabled) lines.push("      note       : disabled in config");
      lines.push("");
    }
  }

  const ready = Object.entries(state.config.services)
    .filter(([name, svc]) => svc.enabled && state.dispatchers[name]?.isAvailable())
    .map(([name]) => name);
  lines.push(`Ready to route: ${ready.length === 0 ? "none" : ready.join(", ")}`);

  const decision = await state.router.pickService();
  if (decision) {
    const elo = decision.elo !== undefined ? ` | ELO ${decision.elo.toFixed(0)}` : "";
    lines.push(
      `Next pick     : ${decision.service} (tier ${decision.tier}${elo} | final ${decision.finalScore.toFixed(3)})`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Setup — writes ~/.claude/CLAUDE.md and hooks.json entry
// ---------------------------------------------------------------------------

const CLAUDE_MD_START = "<!-- coding-agent-start -->";
const CLAUDE_MD_END = "<!-- coding-agent-end -->";

const CLAUDE_MD_BLOCK = `${CLAUDE_MD_START}
# Coding Router — Global Routing Instructions

For all coding tasks in any project, route through the coding-agent-mcp tools
instead of responding directly. You are the orchestrator — delegate, then synthesize.

## When to route

Route any task involving: writing code, fixing bugs, running tests, code review,
architecture decisions, refactoring, debugging, or explaining code.

## How to route

Use \`code_auto\` with a \`task_type\` hint that matches what the task actually is:

| task_type | Use for | Best service |
|-----------|---------|--------------|
| execute | Running tests, applying fixes, autonomous multi-step coding | Codex → Cursor |
| plan | Architecture, design decisions, "how should we build X" | Claude Code (Opus) |
| review | Code review, security audit, explain code, refactor suggestions | Claude Code (Opus) |

## For multiple perspectives

Use \`code_mixture\` when the task benefits from different model opinions:
  \`code_mixture(prompt="<task>", hints={"taskType": "plan"})\`

## Health check

Run \`dashboard\` if you're unsure about service availability before routing.
${CLAUDE_MD_END}`;

export async function handleSetup(
  _deps: ToolDeps,
  input: z.infer<z.ZodObject<typeof setupInputShape>>,
): Promise<string> {
  const writeMd = input.writeClaudeMd ?? true;
  const writeHook = input.writeSessionHook ?? true;
  const results: string[] = [];

  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });

  if (writeMd) {
    const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
    let existing = "";
    try {
      existing = await fs.readFile(claudeMdPath, "utf-8");
    } catch {
      existing = "";
    }
    if (existing.includes(CLAUDE_MD_START)) {
      results.push(`✓ CLAUDE.md  — routing block already present (${claudeMdPath})`);
    } else {
      const merged = (existing.trim() + "\n\n" + CLAUDE_MD_BLOCK).trim() + "\n";
      await fs.writeFile(claudeMdPath, merged);
      results.push(`✓ CLAUDE.md  — routing block written to ${claudeMdPath}`);
    }
  } else {
    results.push("· CLAUDE.md  — skipped (writeClaudeMd=false)");
  }

  if (writeHook) {
    const hooksPath = path.join(claudeDir, "hooks.json");
    let hooks: Record<string, unknown> = {};
    try {
      const text = await fs.readFile(hooksPath, "utf-8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") hooks = parsed as Record<string, unknown>;
    } catch {
      // Create fresh
    }
    const sessionStart = Array.isArray(hooks.SessionStart)
      ? (hooks.SessionStart as Array<Record<string, unknown>>)
      : [];
    const marker = "coding-agent-mcp-session-hook";
    const alreadyHooked = sessionStart.some((entry) => {
      const hs = entry.hooks;
      return Array.isArray(hs) && hs.some((h: unknown) => JSON.stringify(h).includes(marker));
    });
    if (alreadyHooked) {
      results.push(`✓ hooks.json — SessionStart hook already installed (${hooksPath})`);
    } else {
      sessionStart.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node -e "/* ${marker} */ console.log('coding-agent-mcp: use code_auto for coding tasks')"`,
          },
        ],
      });
      hooks.SessionStart = sessionStart;
      await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2));
      results.push(`✓ hooks.json — SessionStart hook installed → ${hooksPath}`);
    }
  } else {
    results.push("· hooks.json — skipped (writeSessionHook=false)");
  }

  results.push("");
  results.push("Restart Claude Code to pick up the hook. CLAUDE.md takes effect immediately.");
  return results.join("\n");
}

// ---------------------------------------------------------------------------
// Registration with McpServer
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
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
] as const;

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "code_with_claude",
    {
      title: "Dispatch to Claude Code",
      description:
        "Route to the best available Claude Code CLI (claude_code harness) service. " +
        "Picks Opus for plan/review, Sonnet for execute.",
      inputSchema: routeInputShape,
    },
    async (args, extra) =>
      jsonText(await handleCodeWithHarness(deps, "claude_code", args, 1, extra as ToolExtra)),
  );

  server.registerTool(
    "code_with_cursor",
    {
      title: "Dispatch to Cursor",
      description:
        "Route to the best available Cursor agent CLI (cursor harness) service. " +
        "Editor-aware with codebase indexing.",
      inputSchema: routeInputShape,
    },
    async (args, extra) =>
      jsonText(await handleCodeWithHarness(deps, "cursor", args, 2, extra as ToolExtra)),
  );

  server.registerTool(
    "code_with_codex",
    {
      title: "Dispatch to Codex",
      description:
        "Route to the best available Codex CLI (codex harness) service. " +
        "Full-auto execution, best for execute task type.",
      inputSchema: routeInputShape,
    },
    async (args, extra) =>
      jsonText(await handleCodeWithHarness(deps, "codex", args, 1, extra as ToolExtra)),
  );

  server.registerTool(
    "code_with_gemini",
    {
      title: "Dispatch to Gemini CLI",
      description:
        "Route to the best available Gemini CLI (gemini_cli harness) service. " +
        "1M+ token context, strong for plan/review.",
      inputSchema: routeInputShape,
    },
    async (args, extra) =>
      jsonText(await handleCodeWithHarness(deps, "gemini_cli", args, 1, extra as ToolExtra)),
  );

  server.registerTool(
    "code_auto",
    {
      title: "Auto-route",
      description:
        "Route a coding task to the best available service based on live quota, ELO " +
        "quality, CLI capability, and per-task-type capability profiles.",
      inputSchema: autoInputShape,
    },
    async (args, extra) => jsonText(await handleCodeAuto(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "code_mixture",
    {
      title: "Mixture of Agents",
      description:
        "Fan out the prompt to all available services in parallel, then return a " +
        "per-service result array for the caller to synthesize.",
      inputSchema: mixtureInputShape,
    },
    async (args, extra) => jsonText(await handleCodeMixture(deps, args, extra as ToolExtra)),
  );

  server.registerTool(
    "get_quota_status",
    {
      title: "Quota + circuit breaker status",
      description: "Return quota and circuit-breaker status for every configured service.",
      inputSchema: {} as const,
    },
    async () => jsonText(await handleQuotaStatus(deps)),
  );

  server.registerTool(
    "list_available_services",
    {
      title: "List services",
      description:
        "List every configured service with harness, tier, weight, capability, max " +
        "output/input tokens, and live reachability.",
      inputSchema: {} as const,
    },
    async () => jsonText(await handleListServices(deps)),
  );

  server.registerTool(
    "dashboard",
    {
      title: "Status dashboard",
      description:
        "Multi-line text dashboard — reachability, quota, circuit-breaker state, " +
        "and session call counts for every configured service.",
      inputSchema: {} as const,
    },
    async () => plainText(await handleDashboard(deps)),
  );

  server.registerTool(
    "setup",
    {
      title: "Install CLAUDE.md + SessionStart hook",
      description:
        "Write routing guidance to ~/.claude/CLAUDE.md and install a SessionStart " +
        "hook that reminds Claude Code to use the router tools.",
      inputSchema: setupInputShape,
    },
    async (args) => plainText(await handleSetup(deps, args)),
  );
}

// ---------------------------------------------------------------------------
// Test convenience — invoke a tool handler by name without going through MCP.
// ---------------------------------------------------------------------------

export type InvokeResult =
  | { kind: "json"; data: unknown }
  | { kind: "text"; data: string };

export async function invokeTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<InvokeResult> {
  switch (name) {
    case "code_with_claude": {
      const parsed = z.object(routeInputShape).parse(args);
      return { kind: "json", data: await handleCodeWithHarness(deps, "claude_code", parsed, 1) };
    }
    case "code_with_cursor": {
      const parsed = z.object(routeInputShape).parse(args);
      return { kind: "json", data: await handleCodeWithHarness(deps, "cursor", parsed, 2) };
    }
    case "code_with_codex": {
      const parsed = z.object(routeInputShape).parse(args);
      return { kind: "json", data: await handleCodeWithHarness(deps, "codex", parsed, 1) };
    }
    case "code_with_gemini": {
      const parsed = z.object(routeInputShape).parse(args);
      return { kind: "json", data: await handleCodeWithHarness(deps, "gemini_cli", parsed, 1) };
    }
    case "code_auto": {
      const parsed = z.object(autoInputShape).parse(args);
      return { kind: "json", data: await handleCodeAuto(deps, parsed) };
    }
    case "code_mixture": {
      const parsed = z.object(mixtureInputShape).parse(args);
      return { kind: "json", data: await handleCodeMixture(deps, parsed) };
    }
    case "get_quota_status":
      return { kind: "json", data: await handleQuotaStatus(deps) };
    case "list_available_services":
      return { kind: "json", data: await handleListServices(deps) };
    case "dashboard":
      return { kind: "text", data: await handleDashboard(deps) };
    case "setup": {
      const parsed = z.object(setupInputShape).parse(args);
      return { kind: "text", data: await handleSetup(deps, parsed) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
