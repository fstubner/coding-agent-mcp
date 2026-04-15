/**
 * OpenTelemetry initialization for coding-agent-mcp.
 *
 * Call `initObservability()` once at process startup (from the CLI or MCP
 * server entry points). Subsequent calls are no-ops. If the environment
 * variable `OTEL_SDK_DISABLED=true` is set, initialization is skipped
 * entirely — useful for tests and for operators who don't want traces.
 *
 * The SDK exports OTLP/HTTP to `http://localhost:4318/v1/traces` by default.
 * Override with `OTEL_EXPORTER_OTLP_ENDPOINT` (standard env var) or by passing
 * `otlpUrl` to `initObservability`.
 *
 * Auto-instrumentation of Node core (http, fs, child_process, etc.) is
 * installed so dispatcher subprocess spawns and fetch calls are traced out
 * of the box alongside our manual dispatcher/router/MCP spans.
 */

import type { Span } from "@opentelemetry/api";

const SERVICE_NAME_DEFAULT = "coding-agent-mcp";
const SERVICE_VERSION = "1.0.0-alpha.0";

export interface InitObservabilityOpts {
  /** Override the OTLP endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT or http://localhost:4318. */
  otlpUrl?: string;
  /** Override the service name attached to spans. Defaults to coding-agent-mcp. */
  serviceName?: string;
  /** Inject instrumentations for tests — production uses auto-instrumentations. */
  instrumentations?: unknown[];
}

let initialized = false;
let sdkRef: { shutdown: () => Promise<void> } | null = null;

/**
 * Initialize the OpenTelemetry SDK. Idempotent.
 *
 * Returns true if the SDK was initialized by this call, false if it was
 * already running (or if disabled via `OTEL_SDK_DISABLED=true`).
 */
export async function initObservability(opts: InitObservabilityOpts = {}): Promise<boolean> {
  if (initialized) return false;
  if (process.env["OTEL_SDK_DISABLED"] === "true") {
    initialized = true;
    return false;
  }

  // Lazily import so consumers who never call initObservability don't pay the
  // load cost or pick up auto-instrumentations they didn't ask for.
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  );

  const otlpEndpoint =
    opts.otlpUrl ??
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    "http://localhost:4318";

  const exporter = new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
  });

  // Pull auto-instrumentations on demand — keeps cold-start cheap when tests
  // bring their own (empty) instrumentation set.
  let instrumentations = opts.instrumentations;
  if (instrumentations === undefined) {
    try {
      const auto = await import("@opentelemetry/auto-instrumentations-node");
      instrumentations = [auto.getNodeAutoInstrumentations()];
    } catch {
      instrumentations = [];
    }
  }

  const serviceName = opts.serviceName ?? SERVICE_NAME_DEFAULT;

  // NodeSDK's `resource` type changed shape across 0.50.x → 0.52.x. Pass
  // attributes via env var to stay version-agnostic — that's the supported
  // compat path.
  const existingRes = process.env["OTEL_RESOURCE_ATTRIBUTES"] ?? "";
  const resourceParts = [
    `service.name=${serviceName}`,
    `service.version=${SERVICE_VERSION}`,
  ];
  process.env["OTEL_RESOURCE_ATTRIBUTES"] = existingRes
    ? `${existingRes},${resourceParts.join(",")}`
    : resourceParts.join(",");

  const sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: instrumentations as never,
  });

  try {
    sdk.start();
    sdkRef = { shutdown: () => sdk.shutdown() };
    initialized = true;
    return true;
  } catch {
    // SDK failed to start — don't crash the host.
    return false;
  }
}

/** Shut down the observability SDK (drains pending spans). Idempotent. */
export async function shutdownObservability(): Promise<void> {
  if (!sdkRef) return;
  try {
    await sdkRef.shutdown();
  } catch {
    // best-effort drain
  }
  sdkRef = null;
  initialized = false;
}

/** Reset internal state — tests only. */
export function _resetObservabilityForTests(): void {
  initialized = false;
  sdkRef = null;
}

export { withDispatcherSpan, withRouterSpan, withMcpToolSpan } from "./spans.js";
export type { SpanAttrs } from "./spans.js";
export type { Span };
