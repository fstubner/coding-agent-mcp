/**
 * Span helpers for coding-agent-mcp.
 *
 * Thin wrappers around `@opentelemetry/api` that encapsulate the three span
 * types this project emits:
 *
 *   coding-agent-mcp.dispatcher.*   — per-dispatch and per-stream invocations
 *   coding-agent-mcp.router.*       — routing decisions and route() calls
 *   coding-agent-mcp.mcp.tool       — MCP tool invocations
 *
 * Each helper takes a name, an attribute bag, and an async function. The
 * helper sets standard attributes, records exceptions, sets status, and
 * ensures the span is ended regardless of whether `fn` resolves or throws.
 *
 * When the SDK is not initialized, these helpers fall back to `trace.getTracer`
 * which returns a no-op tracer — span creation is essentially free.
 */

import { SpanStatusCode, trace, type Span, type Attributes } from "@opentelemetry/api";

const TRACER_NAME = "coding-agent-mcp";
const TRACER_VERSION = "1.0.0-alpha.0";

export interface SpanAttrs {
  [key: string]: string | number | boolean | undefined;
}

function tracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

function assignAttrs(span: Span, attrs: SpanAttrs): void {
  const bag: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    bag[key] = value;
  }
  if (Object.keys(bag).length > 0) span.setAttributes(bag);
}

/**
 * Common implementation — runs `fn` inside a new span, records success /
 * exception, ends the span.
 */
async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, async (span: Span) => {
    const t0 = Date.now();
    try {
      assignAttrs(span, attrs);
      const out = await fn(span);
      const durationMs = Date.now() - t0;
      span.setAttribute("duration_ms", durationMs);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      const durationMs = Date.now() - t0;
      span.setAttribute("duration_ms", durationMs);
      const e = err instanceof Error ? err : new Error(String(err));
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Dispatcher spans
// ---------------------------------------------------------------------------

export interface DispatcherSpanAttrs extends SpanAttrs {
  "dispatcher.id": string;
  "dispatcher.harness"?: string;
  model?: string;
  task_type?: string;
  "tokens.input"?: number;
  "tokens.output"?: number;
  success?: boolean;
  rate_limited?: boolean;
}

export async function withDispatcherSpan<T>(
  op: "dispatch" | "stream",
  attrs: DispatcherSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(`coding-agent-mcp.dispatcher.${op}`, attrs, fn);
}

// ---------------------------------------------------------------------------
// Router spans
// ---------------------------------------------------------------------------

export interface RouterSpanAttrs extends SpanAttrs {
  "router.op": "route" | "pick_service" | "route_to" | "stream";
  task_type?: string;
  service?: string;
  tier?: number;
  success?: boolean;
}

export async function withRouterSpan<T>(
  attrs: RouterSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const { "router.op": op, ...rest } = attrs;
  return withSpan(`coding-agent-mcp.router.${op}`, { ...rest, "router.op": op }, fn);
}

// ---------------------------------------------------------------------------
// MCP tool spans
// ---------------------------------------------------------------------------

export interface McpToolSpanAttrs extends SpanAttrs {
  "tool.name": string;
  service?: string;
  success?: boolean;
}

export async function withMcpToolSpan<T>(
  attrs: McpToolSpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan("coding-agent-mcp.mcp.tool", attrs, fn);
}
