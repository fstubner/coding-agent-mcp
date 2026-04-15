/**
 * MCP server entry points for coding-agent-mcp.
 *
 * Exposes:
 *   startMcpServer({ configPath })            — stdio transport (default).
 *   startMcpHttpServer({ configPath, port })  — streamable-HTTP transport.
 *
 * Both functions return a handle with `close()` so the caller (tests, bin.ts)
 * can shut the server down cleanly.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { bootstrapRuntime, ConfigHotReloader, RuntimeHolder } from "./config-hot-reload.js";
import { registerTools } from "./tools.js";
import { initObservability } from "../observability/index.js";

// Read the package version lazily so this module stays dependency-free.
const SERVER_NAME = "coding-agent-mcp";
const SERVER_VERSION = "1.0.0-alpha.0";

const SERVER_INSTRUCTIONS =
  "Route coding tasks via code_auto (with taskType hint: execute | plan | review), " +
  "code_mixture (to fan out to multiple services), or code_with_<harness>. " +
  "Use dashboard / get_quota_status / list_available_services to inspect live state.";

// ---------------------------------------------------------------------------
// Builder — shared between stdio and HTTP entry points
// ---------------------------------------------------------------------------

export interface BuildMcpOptions {
  /** Path to config.yaml. Omit to auto-detect installed CLIs. */
  configPath?: string;
}

export interface BuiltMcp {
  server: McpServer;
  holder: RuntimeHolder;
  reloader: ConfigHotReloader;
}

/** Bootstrap runtime state + build an `McpServer` with all tools registered. */
export async function buildMcpServer(opts: BuildMcpOptions = {}): Promise<BuiltMcp> {
  // Initialize OpenTelemetry once. Idempotent; no-op when OTEL_SDK_DISABLED=true.
  await initObservability();

  const stateOpts: { configPath?: string } = {};
  if (opts.configPath !== undefined) stateOpts.configPath = opts.configPath;
  const state = await bootstrapRuntime(stateOpts);
  const holder = new RuntimeHolder(state);
  const reloader = new ConfigHotReloader(holder, opts.configPath);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, { holder, reloader });
  return { server, holder, reloader };
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

export interface McpHandle {
  close(): Promise<void>;
}

export async function startMcpServer(opts: BuildMcpOptions = {}): Promise<McpHandle> {
  const { server } = await buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP (streamable)
// ---------------------------------------------------------------------------

export interface HttpMcpHandle extends McpHandle {
  /** The actual port the HTTP server is listening on. */
  port: number;
}

export interface StartHttpOptions extends BuildMcpOptions {
  port?: number;
  /** Path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  route?: string;
}

export async function startMcpHttpServer(opts: StartHttpOptions = {}): Promise<HttpMcpHandle> {
  const { server } = await buildMcpServer(opts);
  const route = opts.route ?? "/mcp";
  const port = opts.port ?? 0;

  // One transport per session (stateful). Sessions are negotiated via the
  // `mcp-session-id` HTTP header.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let connected = false;

  const http: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== route) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        if (!connected) {
          await server.connect(transport as unknown as Transport);
          connected = true;
        }
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    http.listen(port, () => resolve());
  });
  const addr = http.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    port: actualPort,
    async close() {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          // best-effort
        }
      }
      transports.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await server.close();
    },
  };
}
