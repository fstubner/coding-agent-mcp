/**
 * coding-agent-mcp — TypeScript rewrite.
 *
 * Public library surface. Stable starting at R3.
 */

export { Router } from "./router.js";
export type { RouterStreamEvent } from "./router.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { QuotaCache, QuotaState } from "./quota.js";
export { LeaderboardCache } from "./leaderboard.js";
export { loadConfig, watchConfig } from "./config.js";
export * from "./types.js";
export type { Dispatcher, DispatchOpts } from "./dispatchers/base.js";
export { BaseDispatcher, drainDispatcherStream } from "./dispatchers/base.js";

// Shared streaming subprocess helper (R3)
export {
  streamSubprocess,
  drainSubprocessStream,
  type SubprocessChunk,
  type SubprocessEnd,
  type SubprocessStreamEvent,
  type StreamSubprocessOpts,
} from "./dispatchers/shared/stream-subprocess.js";

// MCP surface (R2)
export {
  buildMcpServer,
  startMcpServer,
  startMcpHttpServer,
  type BuildMcpOptions,
  type StartHttpOptions,
  type McpHandle,
  type HttpMcpHandle,
} from "./mcp/server.js";
export { buildDispatchers } from "./mcp/dispatcher-factory.js";
export { TOOL_NAMES } from "./mcp/tools.js";

// Observability (R3)
export {
  initObservability,
  shutdownObservability,
  withDispatcherSpan,
  withRouterSpan,
  withMcpToolSpan,
  type InitObservabilityOpts,
  type SpanAttrs,
} from "./observability/index.js";

// Live dashboard (R3)
export { renderDashboard, type DashboardState } from "./dashboard/live.js";

export const VERSION = "1.0.0-alpha.0";
