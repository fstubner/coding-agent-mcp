/**
 * Unit tests for the span helpers.
 *
 * We install an in-memory tracer provider so spans are captured without
 * requiring a real OTLP endpoint. Each helper is exercised for:
 *  - attribute propagation
 *  - success status
 *  - exception recording + error status on thrown functions
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { trace, SpanStatusCode, context } from "@opentelemetry/api";

// In-memory span recording via a lightweight tracer provider stub.
type RecordedSpan = {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  exceptions: Array<{ message: string }>;
  ended: boolean;
};

const recordedSpans: RecordedSpan[] = [];

class StubSpan {
  private rec: RecordedSpan;
  constructor(name: string) {
    this.rec = {
      name,
      attributes: {},
      status: { code: SpanStatusCode.UNSET },
      exceptions: [],
      ended: false,
    };
    recordedSpans.push(this.rec);
  }
  setAttribute(key: string, value: unknown): this {
    this.rec.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.rec.attributes, attrs);
    return this;
  }
  setStatus(status: { code: number; message?: string }): this {
    this.rec.status = status;
    return this;
  }
  recordException(err: Error | string): this {
    this.rec.exceptions.push({
      message: typeof err === "string" ? err : err.message,
    });
    return this;
  }
  end(): void {
    this.rec.ended = true;
  }
  isRecording(): boolean {
    return !this.rec.ended;
  }
  addEvent(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  spanContext() {
    return { traceId: "0", spanId: "0", traceFlags: 0 };
  }
}

class StubTracer {
  startActiveSpan<T>(
    name: string,
    _opts: unknown,
    _ctx: unknown,
    fn?: (span: StubSpan) => T,
  ): T;
  startActiveSpan<T>(name: string, fn: (span: StubSpan) => T): T;
  startActiveSpan<T>(name: string, a: unknown, b?: unknown, c?: unknown): T {
    const fn =
      typeof a === "function"
        ? (a as (s: StubSpan) => T)
        : typeof b === "function"
          ? (b as (s: StubSpan) => T)
          : (c as (s: StubSpan) => T);
    const span = new StubSpan(name);
    return context.with(trace.setSpan(context.active(), span as never), () =>
      fn(span),
    );
  }
  startSpan(name: string): StubSpan {
    return new StubSpan(name);
  }
}

class StubTracerProvider {
  getTracer(): StubTracer {
    return new StubTracer();
  }
}

trace.setGlobalTracerProvider(new StubTracerProvider() as never);

import {
  withDispatcherSpan,
  withRouterSpan,
  withMcpToolSpan,
} from "../../src/observability/spans.js";

beforeEach(() => {
  recordedSpans.length = 0;
});

afterAll(() => {
  trace.disable();
});

describe("withDispatcherSpan", () => {
  it("creates a span with the right name + attributes", async () => {
    const result = await withDispatcherSpan(
      "dispatch",
      { "dispatcher.id": "claude_code", model: "opus-4" },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.name).toBe("coding-agent-mcp.dispatcher.dispatch");
    expect(recordedSpans[0]!.attributes["dispatcher.id"]).toBe("claude_code");
    expect(recordedSpans[0]!.attributes["model"]).toBe("opus-4");
    expect(recordedSpans[0]!.status.code).toBe(SpanStatusCode.OK);
    expect(recordedSpans[0]!.ended).toBe(true);
  });

  it("records exception and sets ERROR status on throw", async () => {
    await expect(
      withDispatcherSpan("stream", { "dispatcher.id": "x" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.name).toBe("coding-agent-mcp.dispatcher.stream");
    expect(recordedSpans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(recordedSpans[0]!.exceptions).toHaveLength(1);
    expect(recordedSpans[0]!.exceptions[0]!.message).toBe("boom");
    expect(recordedSpans[0]!.ended).toBe(true);
  });
});

describe("withRouterSpan", () => {
  it("emits the router span with the correct name", async () => {
    await withRouterSpan(
      { "router.op": "route", task_type: "plan" },
      async () => 1,
    );
    expect(recordedSpans[0]!.name).toBe("coding-agent-mcp.router.route");
    expect(recordedSpans[0]!.attributes["task_type"]).toBe("plan");
  });

  it("supports pick_service operation", async () => {
    await withRouterSpan({ "router.op": "pick_service" }, async () => 1);
    expect(recordedSpans[0]!.name).toBe("coding-agent-mcp.router.pick_service");
  });
});

describe("withMcpToolSpan", () => {
  it("emits an mcp.tool span with the tool.name attribute", async () => {
    await withMcpToolSpan({ "tool.name": "code_auto" }, async () => 1);
    expect(recordedSpans[0]!.name).toBe("coding-agent-mcp.mcp.tool");
    expect(recordedSpans[0]!.attributes["tool.name"]).toBe("code_auto");
  });
});
