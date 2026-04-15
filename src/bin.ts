#!/usr/bin/env node
/**
 * coding-agent-mcp — CLI entrypoint.
 *
 * Usage:
 *   coding-agent-mcp route "<prompt>"        Pick a service and dispatch once.
 *   coding-agent-mcp list-services           Show enabled services.
 *   coding-agent-mcp dashboard               Show quota + breaker status.
 *   coding-agent-mcp dashboard --watch       Re-render every <interval> (default 1s).
 *   coding-agent-mcp mcp                     Start the MCP server on stdio.
 *   coding-agent-mcp mcp --http <port>       Start the MCP server over HTTP.
 *
 * Options (apply to all subcommands):
 *   --config <path>   Path to config.yaml (default: auto-detect).
 *   --interval <ms>   Dashboard refresh interval in ms (default: 1000).
 *
 * R3: `route` now consumes Router.stream so stdout chunks print live as the
 * dispatcher produces them. `dashboard --watch` re-renders the live view
 * every interval.
 */

import { parseArgs } from "node:util";
import { Router } from "./router.js";
import { loadConfig } from "./config.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import { startMcpHttpServer, startMcpServer } from "./mcp/server.js";
import { initObservability } from "./observability/index.js";
import { renderDashboard, type DashboardState, type RecentEvent } from "./dashboard/live.js";

// ---------------------------------------------------------------------------
// Commands (R1 + R3 streaming)
// ---------------------------------------------------------------------------

async function cmdRoute(prompt: string, configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  if (Object.keys(dispatchers).length === 0) {
    process.stderr.write(
      "No dispatchers available. Install at least one CLI (claude, agent, codex, gemini) " +
        "and try again, or point --config at a YAML with an explicit services block.\n",
    );
    return 1;
  }
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);

  let seenDecision = false;
  let finalSuccess = false;
  let finalError: string | undefined;
  let finalService = "unknown";

  for await (const { event, decision } of router.stream(prompt, [], process.cwd())) {
    if (decision && !seenDecision) {
      process.stdout.write(
        `-> service: ${decision.service}  tier: ${decision.tier}  score: ${decision.finalScore.toFixed(4)}\n`,
      );
      process.stdout.write(`   reason: ${decision.reason}\n`);
      if (decision.model) process.stdout.write(`   model: ${decision.model}\n`);
      process.stdout.write("--- output ---\n");
      seenDecision = true;
    }
    switch (event.type) {
      case "stdout":
        process.stdout.write(event.chunk);
        break;
      case "stderr":
        process.stderr.write(event.chunk);
        break;
      case "tool_use":
        process.stderr.write(`[tool_use ${event.name}]\n`);
        break;
      case "thinking":
        // Dim/compact thinking trace to stderr so it doesn't contaminate stdout.
        process.stderr.write(`[thinking] ${event.chunk}\n`);
        break;
      case "completion":
        finalSuccess = event.result.success;
        finalService = event.result.service;
        if (!finalSuccess) finalError = event.result.error;
        if (!event.result.output.endsWith("\n")) process.stdout.write("\n");
        break;
      case "error":
        finalError = event.error;
        break;
    }
  }

  if (!seenDecision) {
    process.stderr.write("No routing decision could be made.\n");
    return 1;
  }
  if (!finalSuccess) {
    process.stderr.write(
      `[error] ${finalError ?? "(no error message)"} (service=${finalService})\n`,
    );
    return 1;
  }
  return 0;
}

async function cmdListServices(configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const rows: string[] = [];
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const harness = svc.harness ?? name;
    const parts = [
      name,
      `harness=${harness}`,
      `tier=${svc.tier}`,
      `weight=${svc.weight}`,
      svc.leaderboardModel ? `lb=${svc.leaderboardModel}` : "",
    ].filter(Boolean);
    rows.push(parts.join("  "));
  }
  if (rows.length === 0) {
    process.stdout.write("(no enabled services)\n");
  } else {
    for (const r of rows) process.stdout.write(`${r}\n`);
  }
  return 0;
}

async function buildDashboardState(
  config: Awaited<ReturnType<typeof loadConfig>>,
  dispatchers: Awaited<ReturnType<typeof buildDispatchers>>,
  quota: QuotaCache,
  router: Router,
  ansi: boolean,
  recent: RecentEvent[] = [],
): Promise<DashboardState> {
  const breakers = router.circuitBreakerStatus();
  const fullQuota = await quota.fullStatus();
  const services: DashboardState["services"] = [];
  const quotas: DashboardState["quotas"] = {};
  const brks: DashboardState["breakers"] = {};

  for (const [name, svc] of Object.entries(config.services)) {
    const dispatcher = dispatchers[name];
    const reachable = dispatcher?.isAvailable() ?? false;
    services.push({ name, config: svc, reachable });
    const q = fullQuota[name];
    if (q) {
      quotas[name] = {
        score: q.score,
        remaining: q.remaining ?? null,
        limit: q.limit ?? null,
        localCallCount: q.localCallCount,
        ...(q.resetAt ? { resetAt: q.resetAt } : {}),
      };
    } else {
      const score = await quota.getQuotaScore(name);
      quotas[name] = { score };
    }
    const b = breakers[name];
    if (b) brks[name] = b;
  }
  return {
    services,
    quotas,
    breakers: brks,
    recentEvents: recent,
    generatedAt: Date.now(),
    ansi,
  };
}

async function cmdDashboard(
  configPath: string | undefined,
  watch: boolean,
  intervalMs: number,
): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);

  const isTty = Boolean(process.stdout.isTTY);

  if (!watch) {
    const state = await buildDashboardState(config, dispatchers, quota, router, isTty);
    process.stdout.write(renderDashboard(state) + "\n");
    return 0;
  }

  // Live-redraw loop. Ctrl-C exits.
  let running = true;
  const onSigint = () => {
    running = false;
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);

  try {
    while (running) {
      const state = await buildDashboardState(config, dispatchers, quota, router, isTty);
      process.stdout.write(renderDashboard(state) + "\n");
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Commands (R2 — MCP server)
// ---------------------------------------------------------------------------

async function cmdMcp(
  configPath: string | undefined,
  httpPort: number | undefined,
): Promise<number> {
  if (httpPort !== undefined) {
    const buildOpts: { configPath?: string } = {};
    if (configPath !== undefined) buildOpts.configPath = configPath;
    const handle = await startMcpHttpServer({ ...buildOpts, port: httpPort });
    process.stderr.write(
      `coding-agent-mcp listening on http://localhost:${handle.port}/mcp\n`,
    );
    const shutdown = async (): Promise<void> => {
      try {
        await handle.close();
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise<void>(() => {
      /* never resolves */
    });
    return 0;
  }

  const buildOpts: { configPath?: string } = {};
  if (configPath !== undefined) buildOpts.configPath = configPath;
  const handle = await startMcpServer(buildOpts);
  const shutdown = async (): Promise<void> => {
    try {
      await handle.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {
    /* never resolves */
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  process.stdout.write(
    [
      "coding-agent-mcp CLI",
      "",
      "Usage:",
      '  coding-agent-mcp route "<prompt>"   Pick a service and dispatch (live streaming).',
      "  coding-agent-mcp list-services      Show enabled services.",
      "  coding-agent-mcp dashboard          Show quota + breaker status (one-shot).",
      "  coding-agent-mcp dashboard --watch  Re-render every --interval ms.",
      "  coding-agent-mcp mcp                Start the MCP server (stdio).",
      "  coding-agent-mcp mcp --http <port>  Start the MCP server (HTTP).",
      "",
      "Options:",
      "  --config <path>   Path to config.yaml (default: auto-detect)",
      "  --interval <ms>   Dashboard refresh interval (default 1000).",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      http: { type: "string" },
      help: { type: "boolean", short: "h" },
      watch: { type: "boolean" },
      interval: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    return values.help ? 0 : 1;
  }

  // Initialize observability once per CLI invocation. Idempotent; no-op
  // when OTEL_SDK_DISABLED=true. Spans without a configured backend are
  // emitted to a no-op exporter.
  await initObservability();

  const [command, ...rest] = positionals;
  const configPath = values.config as string | undefined;

  switch (command) {
    case "route": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        process.stderr.write('route: missing prompt. Usage: route "<prompt>"\n');
        return 1;
      }
      return cmdRoute(prompt, configPath);
    }
    case "list-services":
      return cmdListServices(configPath);
    case "dashboard": {
      const watch = Boolean(values.watch);
      let intervalMs = 1000;
      if (values.interval !== undefined) {
        const parsed = Number(values.interval);
        if (Number.isFinite(parsed) && parsed > 0) intervalMs = parsed;
      }
      return cmdDashboard(configPath, watch, intervalMs);
    }
    case "mcp": {
      let httpPort: number | undefined;
      if (values.http !== undefined) {
        const parsed = Number(values.http);
        if (Number.isNaN(parsed)) {
          process.stderr.write(`mcp --http: expected a port number, got "${values.http}"\n`);
          return 1;
        }
        httpPort = parsed;
      }
      return cmdMcp(configPath, httpPort);
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 1;
  }
}

const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : "";
if (entrypoint && (entrypoint.endsWith("bin.ts") || entrypoint.endsWith("bin.js"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
