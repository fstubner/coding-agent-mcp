/**
 * Dispatcher streaming tests — mock `runSubprocess` (which the streaming
 * subprocess helper delegates to in test mode) and assert the events
 * emitted by each CLI dispatcher's `stream()` method.
 *
 * The adapter in `stream-subprocess.ts` detects the vi.fn() mock on
 * runSubprocess and synthesises a stream from its buffered result.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubprocessResult } from "../../src/dispatchers/shared/subprocess.js";
import type { DispatcherEvent } from "../../src/types.js";

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/windows-cmd.js", () => ({
  resolveCliCommand: vi.fn(),
}));
vi.mock("which", () => ({ default: vi.fn() }));

const { runSubprocess } = await import("../../src/dispatchers/shared/subprocess.js");
const { resolveCliCommand } = await import("../../src/dispatchers/shared/windows-cmd.js");
const { default: which } = await import("which");
const { ClaudeCodeDispatcher } = await import("../../src/dispatchers/claude-code.js");
const { CodexDispatcher } = await import("../../src/dispatchers/codex.js");
const { CursorDispatcher } = await import("../../src/dispatchers/cursor.js");
const { GeminiDispatcher } = await import("../../src/dispatchers/gemini.js");

const runMock = runSubprocess as unknown as ReturnType<typeof vi.fn>;
const resolveMock = resolveCliCommand as unknown as ReturnType<typeof vi.fn>;
const whichMock = which as unknown as ReturnType<typeof vi.fn>;

function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 42,
    timedOut: false,
    ...overrides,
  };
}

function mockFound(cmd = "/usr/local/bin/fake"): void {
  whichMock.mockResolvedValue(cmd);
  resolveMock.mockResolvedValue({ command: cmd, prefixArgs: [] });
}

async function collect(iter: AsyncIterable<DispatcherEvent>): Promise<DispatcherEvent[]> {
  const out: DispatcherEvent[] = [];
  for await (const evt of iter) out.push(evt);
  return out;
}

beforeEach(() => {
  runMock.mockReset();
  resolveMock.mockReset();
  whichMock.mockReset();
});

describe("ClaudeCodeDispatcher.stream", () => {
  it("yields stdout then a completion event", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({ stdout: JSON.stringify({ result: "hi there", usage: { input_tokens: 3, output_tokens: 4 } }) }),
    );
    const events = await collect(new ClaudeCodeDispatcher().stream("do it", [], "/tmp"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("stdout");
    expect(types[types.length - 1]).toBe("completion");
    const last = events[events.length - 1]!;
    expect(last.type).toBe("completion");
    if (last.type === "completion") {
      expect(last.result.success).toBe(true);
      expect(last.result.output).toBe("hi there");
      expect(last.result.tokensUsed).toEqual({ input: 3, output: 4 });
    }
  });

  it("yields a failure completion when the CLI is not installed", async () => {
    whichMock.mockResolvedValue(null);
    const events = await collect(new ClaudeCodeDispatcher().stream("hi", [], ""));
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.type).toBe("completion");
    if (evt.type === "completion") {
      expect(evt.result.success).toBe(false);
      expect(evt.result.error).toMatch(/claude CLI not found/);
    }
  });
});

describe("CodexDispatcher.stream", () => {
  it("emits stdout chunks and a completion with summed usage", async () => {
    mockFound();
    const jsonl =
      JSON.stringify({ type: "thread.started" }) +
      "\n" +
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "result" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }) +
      "\n";
    runMock.mockResolvedValue(ok({ stdout: jsonl }));
    const events = await collect(new CodexDispatcher().stream("go", [], ""));
    const completion = events.find((e) => e.type === "completion");
    expect(completion).toBeDefined();
    if (completion?.type === "completion") {
      expect(completion.result.output).toBe("result");
      expect(completion.result.tokensUsed).toEqual({ input: 2, output: 3 });
    }
  });

  it("emits a completion with error for non-zero exit", async () => {
    mockFound();
    runMock.mockResolvedValue(ok({ stdout: "", stderr: "boom", exitCode: 2 }));
    const events = await collect(new CodexDispatcher().stream("go", [], ""));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(false);
      expect(completion.result.error).toBe("boom");
    }
  });
});

describe("CursorDispatcher.stream", () => {
  it("yields stdout then a completion with the parsed result", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          result: "cursor output",
          usage: { input_tokens: 5, output_tokens: 7 },
        }),
      }),
    );
    const events = await collect(new CursorDispatcher().stream("write tests", [], "/tmp/work"));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(true);
      expect(completion.result.output).toBe("cursor output");
      expect(completion.result.tokensUsed).toEqual({ input: 5, output: 7 });
    }
  });

  it("marks rateLimited=true on 429 indicators in stderr", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({
        exitCode: 1,
        stderr: "Error: 429 rate limit exceeded",
      }),
    );
    const events = await collect(new CursorDispatcher().stream("go", [], "/tmp/work"));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(false);
      expect(completion.result.rateLimited).toBe(true);
    }
  });
});

describe("GeminiDispatcher.stream", () => {
  it("yields completion with the parsed response", async () => {
    mockFound();
    runMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          response: "gemini says hi",
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      }),
    );
    const events = await collect(new GeminiDispatcher().stream("hi", [], ""));
    const completion = events.find((e) => e.type === "completion");
    expect(completion?.type).toBe("completion");
    if (completion?.type === "completion") {
      expect(completion.result.success).toBe(true);
      expect(completion.result.output).toBe("gemini says hi");
    }
  });
});

describe("dispatch() still drains the stream correctly", () => {
  it("claude_code dispatch works through BaseDispatcher default", async () => {
    mockFound();
    runMock.mockResolvedValue(ok({ stdout: JSON.stringify({ result: "ok" }) }));
    const res = await new ClaudeCodeDispatcher().dispatch("go", [], "");
    expect(res.success).toBe(true);
    expect(res.output).toBe("ok");
  });
});
