import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SubprocessResult } from "../../src/dispatchers/shared/subprocess.js";

vi.mock("../../src/dispatchers/shared/subprocess.js", () => ({
  runSubprocess: vi.fn(),
}));
vi.mock("../../src/dispatchers/shared/windows-cmd.js", () => ({
  resolveCliCommand: vi.fn(),
}));

const { runSubprocess } = await import(
  "../../src/dispatchers/shared/subprocess.js"
);
const { resolveCliCommand } = await import(
  "../../src/dispatchers/shared/windows-cmd.js"
);
const { CodexDispatcher } = await import(
  "../../src/dispatchers/codex.js"
);

const runSubprocessMock = runSubprocess as unknown as ReturnType<
  typeof vi.fn
>;
const resolveCliCommandMock = resolveCliCommand as unknown as ReturnType<
  typeof vi.fn
>;

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

const savedEnv = { ...process.env };

beforeEach(() => {
  runSubprocessMock.mockReset();
  resolveCliCommandMock.mockReset();
});

afterEach(() => {
  // Restore env to avoid bleed across tests.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    process.env[k] = v;
  }
});

describe("CodexDispatcher", () => {
  it("returns an error DispatchResult when the CLI is not found", async () => {
    resolveCliCommandMock.mockReturnValue(null);
    const d = new CodexDispatcher();

    const res = await d.dispatch("hi", [], "");

    expect(res.success).toBe(false);
    expect(res.service).toBe("codex");
    expect(res.error).toMatch(/codex CLI not found/i);
    expect(runSubprocessMock).not.toHaveBeenCalled();
  });

  it("extracts the last agent_message item from JSONL output", async () => {
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    const jsonl = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "first" },
        usage: { input_tokens: 4, output_tokens: 5 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "final answer" },
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ].join("\n");
    runSubprocessMock.mockResolvedValue(ok({ stdout: jsonl }));

    const d = new CodexDispatcher();
    const res = await d.dispatch("write code", [], "");

    expect(res.success).toBe(true);
    expect(res.service).toBe("codex");
    expect(res.output).toBe("final answer");
    // Usage is summed across events.
    expect(res.tokensUsed).toEqual({ input: 6, output: 8 });
  });

  it("appends --cd <workingDir> when workingDir is non-empty", async () => {
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "/tmp/project");

    const call = runSubprocessMock.mock.calls[0]![0] as {
      args: string[];
    };
    expect(call.args).toContain("--cd");
    const idx = call.args.indexOf("--cd");
    expect(call.args[idx + 1]).toBe("/tmp/project");
  });

  it("does NOT append --cd when workingDir is empty", async () => {
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const call = runSubprocessMock.mock.calls[0]![0] as {
      args: string[];
    };
    expect(call.args).not.toContain("--cd");
  });

  it("forwards OPENAI_API_KEY from process.env to the subprocess", async () => {
    process.env["OPENAI_API_KEY"] = "sk-test-12345";
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const call = runSubprocessMock.mock.calls[0]![0] as {
      extraEnv?: Record<string, string>;
    };
    expect(call.extraEnv).toBeDefined();
    expect(call.extraEnv!["OPENAI_API_KEY"]).toBe("sk-test-12345");
  });

  it("does NOT forward OPENAI_API_KEY when the env var is unset", async () => {
    delete process.env["OPENAI_API_KEY"];
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "");

    const call = runSubprocessMock.mock.calls[0]![0] as {
      extraEnv?: Record<string, string>;
    };
    // extraEnv should either be undefined or not contain the key.
    if (call.extraEnv) {
      expect(call.extraEnv["OPENAI_API_KEY"]).toBeUndefined();
    }
  });

  it("passes --model <override> through to the subprocess", async () => {
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "ok" },
        }),
      }),
    );

    const d = new CodexDispatcher();
    await d.dispatch("go", [], "", { modelOverride: "o4-mini" });

    const call = runSubprocessMock.mock.calls[0]![0] as {
      args: string[];
    };
    expect(call.args).toContain("--model");
    const idx = call.args.indexOf("--model");
    expect(call.args[idx + 1]).toBe("o4-mini");
  });

  it("reports failure on a non-zero exit code", async () => {
    resolveCliCommandMock.mockReturnValue({
      command: "codex",
      prefixArgs: [],
    });
    runSubprocessMock.mockResolvedValue(
      ok({ stdout: "", stderr: "something broke", exitCode: 2 }),
    );

    const d = new CodexDispatcher();
    const res = await d.dispatch("go", [], "");

    expect(res.success).toBe(false);
    expect(res.error).toBe("something broke");
  });

  it("reports 'unknown' quota in R1", async () => {
    const d = new CodexDispatcher();
    const q = await d.checkQuota();
    expect(q.service).toBe("codex");
    expect(q.source).toBe("unknown");
  });

  it("has a stable id and reports itself as available", () => {
    const d = new CodexDispatcher();
    expect(d.id).toBe("codex");
    expect(d.isAvailable()).toBe(true);
  });
});
