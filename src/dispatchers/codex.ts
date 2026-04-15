/**
 * OpenAI Codex CLI dispatcher for coding-agent-mcp.
 *
 * Dispatch:  codex exec "<prompt>" --full-auto --json [--model <m>] [--cd <dir>]
 *   codex exec: non-interactive mode.
 *   --full-auto: bypass approval prompts.
 *   --json:      newline-delimited JSON events for structured parsing.
 *
 * Quota: Reactive only. Codex uses token-based pricing (no hard monthly limit);
 * circuit breaker handles exhaustion from 429 responses.
 *
 * R3: emits JSONL events as they're parsed — `tool_use` and `thinking`
 * events surface mid-run, `completion` fires once the child exits.
 */

import which from "which";
import type { DispatchResult, DispatcherEvent, QuotaInfo } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
  };
  message?: {
    content?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class CodexDispatcher extends BaseDispatcher {
  readonly id = "codex";

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "codex", source: "unknown" };
  }

  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): AsyncIterable<DispatcherEvent> {
    return this.#runStream(prompt, files, workingDir, opts);
  }

  async *#runStream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts,
  ): AsyncGenerator<DispatcherEvent> {
    const foundPath = await which("codex", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "codex",
          success: false,
          error: "codex CLI not found",
        },
      };
      return;
    }
    const resolved = await resolveCliCommand("codex");

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFiles to work with:\n${fileList}`;
    }

    const args: string[] = [
      ...resolved.prefixArgs,
      "exec",
      fullPrompt,
      "--full-auto",
      "--json",
    ];
    if (opts.modelOverride) {
      args.push("--model", opts.modelOverride);
    }
    if (workingDir) {
      args.push("--cd", workingDir);
    }

    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey) {
      extraEnv["OPENAI_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    // Incremental JSONL parser — splits on newlines as chunks arrive so we
    // can emit tool_use / thinking events mid-run rather than waiting for
    // the child to exit. Aggregates usage + last agent_message for the
    // final completion event.
    let lineBuffer = "";
    let lastText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    let sawAnyJson = false;

    const emitLine = (line: string): DispatcherEvent[] => {
      const out: DispatcherEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed) return out;
      let event: CodexJsonEvent;
      try {
        event = JSON.parse(trimmed) as CodexJsonEvent;
      } catch {
        return out;
      }
      sawAnyJson = true;

      if (
        event.type === "item.completed" &&
        event.item &&
        event.item.type === "agent_message"
      ) {
        const t = event.item.text;
        if (typeof t === "string" && t.length > 0) {
          lastText = t;
        }
      }
      if (event.type === "message" && event.message?.content) {
        lastText = event.message.content;
      }

      if (
        event.item &&
        event.item.type === "tool_use" &&
        typeof event.item.name === "string"
      ) {
        out.push({
          type: "tool_use",
          name: event.item.name,
          input: event.item.input,
        });
      } else if (event.type === "thinking" && event.item?.text) {
        out.push({ type: "thinking", chunk: event.item.text });
      }

      if (event.usage) {
        const inTok = event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0;
        const outTok = event.usage.output_tokens ?? event.usage.completion_tokens ?? 0;
        if (inTok || outTok) {
          inputTokens += inTok;
          outputTokens += outTok;
          sawUsage = true;
        }
      }
      return out;
    };

    for await (const evt of streamSubprocess(resolved.command, args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
          lineBuffer += evt.chunk;
          let newlineIdx = lineBuffer.indexOf("\n");
          while (newlineIdx >= 0) {
            const line = lineBuffer.slice(0, newlineIdx);
            lineBuffer = lineBuffer.slice(newlineIdx + 1);
            for (const out of emitLine(line)) yield out;
            newlineIdx = lineBuffer.indexOf("\n");
          }
        } else {
          stderrBuf.push(evt.chunk);
          yield { type: "stderr", chunk: evt.chunk };
        }
      } else {
        exitCode = evt.exitCode;
        durationMs = evt.durationMs;
        timedOut = evt.timedOut;
      }
    }

    // Flush any trailing partial line.
    if (lineBuffer.length > 0) {
      for (const out of emitLine(lineBuffer)) yield out;
      lineBuffer = "";
    }

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "codex",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    // Stderr path (Windows cmd /c can shuffle streams). If nothing parsed
    // from stdout, try stderr now.
    if (!sawAnyJson && stderr) {
      for (const line of stderr.split(/\r?\n/)) {
        for (const out of emitLine(line)) yield out;
      }
    }

    const parsedText = sawAnyJson ? lastText.trim() : "";
    const output = parsedText || stdout.trim() || stderr.trim();

    const result: DispatchResult = {
      output,
      service: "codex",
      success: exitCode === 0,
      durationMs,
    };
    if (sawUsage) {
      result.tokensUsed = { input: inputTokens, output: outputTokens };
    }
    if (exitCode !== 0) {
      result.error = stderr.trim() || `Exit code ${exitCode}`;
    }

    yield { type: "completion", result };
  }
}
