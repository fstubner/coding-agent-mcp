#!/usr/bin/env node
/**
 * coding-agent-mcp — CLI entrypoint.
 *
 * Usage:
 *   coding-agent-mcp route "<prompt>"        Pick a service and dispatch once.
 *   coding-agent-mcp list-services           Show enabled services.
 *   coding-agent-mcp dashboard               Show quota + breaker status.
 *   coding-agent-mcp mcp                     Start the MCP server on stdio.
 *   coding-agent-mcp mcp --http <port>       Start the MCP server over HTTP.
 *
 * Options (apply to all subcommands):
 *   --config <path>   Path to config.yaml (default: auto-detect).
 *
 * R1 defined `route / list-services / dashboard`. R2 adds the `mcp` subcommand
 * while keeping the R1 behaviour identical.
 */

import { parseArgs } from "node:util";
import { Router } from "./router.js";
import { loadConfig } from "./config.js";
import { QuotaCache } from "./quota.js";
import { LeaderboardCache } from "./leaderboard.js";
import { buildDispatchers } from "./mcp/dispatcher-factory.js";
import { startMcpHttpServer, startMcpServer } from "./mcp/server.js";

// ---------------------------------------------------------------------------
// Commands (R1)
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

  const { result, decision } = await router.route(prompt, [], process.cwd());
  if (decision) {
    process.stdout.write(
      `-> service: ${decision.service}  tier: ${decision.tier}  score: ${decision.finalScore.toFixed(4)}\n`,
    );
    process.stdout.write(`   reason: ${decision.reason}\n`);
    if (decision.model) process.stdout.write(`   model: ${decision.model}\n`);
  } else {
    process.stderr.write("No routing decision could be made.\n");
  }
  process.stdout.write("--- output ---\n");
  process.stdout.write(result.output);
  if (!result.output.endsWith("\n")) process.stdout.write("\n");
  if (!result.success) {
    process.stderr.write(`[error] ${result.error ?? "(no error message)"}\n`);
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

async function cmdDashboard(configPath: string | undefined): Promise<number> {
  const config = await loadConfig(configPath);
  const dispatchers = await buildDispatchers(config);
  const quota = new QuotaCache(dispatchers);
  const leaderboard = new LeaderboardCache();
  const router = new Router(config, quota, dispatchers, leaderboard);

  const bstatus = router.circuitBreakerStatus();
  process.stdout.write("--- circuit breakers ---\n");
  for (const [name, s] of Object.entries(bstatus)) {
    process.stdout.write(`${name}: ${JSON.stringify(s)}\n`);
  }

  process.stdout.write("--- quota ---\n");
  for (const name of Object.keys(config.services)) {
    const score = await quota.getQuotaScore(name);
    process.stdout.write(`${name}: score=${score.toFixed(3)}\n`);
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
    // Block forever — the HTTP server keeps the event loop alive anyway.
    await new Promise<void>(() => {
      /* intentionally never resolves */
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
  // stdio transport keeps the process alive on its own.
  await new Promise<void>(() => {
    /* intentionally never resolves */
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
      '  coding-agent-mcp route "<prompt>"   Pick a service and dispatch.',
      "  coding-agent-mcp list-services      Show enabled services.",
      "  coding-agent-mcp dashboard          Show quota + breaker status.",
      "  coding-agent-mcp mcp                Start the MCP server (stdio).",
      "  coding-agent-mcp mcp --http <port>  Start the MCP server (HTTP).",
      "",
      "Options:",
      "  --config <path>   Path to config.yaml (default: auto-detect)",
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
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    return values.help ? 0 : 1;
  }

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
    case "dashboard":
      return cmdDashboard(configPath);
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

// When invoked directly (not imported), run and set exit code.
const entrypoint =
  typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv[1] : "";
if (entrypoint && (entrypoint.endsWith("bin.ts") || entrypoint.endsWith("bin.js"))) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
