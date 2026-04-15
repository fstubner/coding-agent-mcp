/**
 * Claude Code CLI dispatcher for coding-agent-mcp.
 *
 * Dispatch:  claude -p "<prompt>" --output-format json
 *                  --allowedTools "Bash,Read,Edit,Write"
 *                  --permission-mode acceptEdits
 *
 *   -p / --print             Non-interactive mode (prints response and exits).
 *   --output-format json     Structured output with a top-level 'result' field.
 *   --allowedTools           Pre-approve tools so no interactive prompts block.
 *   --permission-mode acceptEdits  Allow file writes without per-edit confirmation.
 *
 * Auth: --bare is intentionally NOT used. --bare bypasses OAuth/keychain and
 * requires ANTHROPIC_API_KEY. We use subscription auth (Claude Desktop OAuth),
 * so omitting --bare lets the CLI pick up the saved credentials normally.
 *
 * R3: streaming is the canonical entry point. The CLI emits a single JSON
 * object at the end of the run, so stdout chunks are surfaced verbatim as
 * `stdout` events, and the `completion` event (built from the fully-buffered
 * stdout) is yielded once the child exits.
 */

import which from "which";
import type { DispatchResult, DispatcherEvent, QuotaInfo } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const ALLOWED_TOOLS = "Bash,Read,Edit,Write";
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface ClaudeJsonResult {
  result?: unknown;
  response?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class ClaudeCodeDispatcher extends BaseDispatcher {
  readonly id = "claude_code";

  isAvailable(): boolean {
    // Synchronous check; runtime availability is re-verified at dispatch time
    // via resolveCliCommand (which performs the actual PATH lookup).
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    // No proactive quota endpoint for Claude Code (subscription auth).
    // Reactive circuit-breaker handles rate limits. Deferred to R3.
    return { service: "claude_code", source: "unknown" };
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
    const foundPath = await which("claude", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "claude_code",
          success: false,
          error: "claude CLI not found",
        },
      };
      return;
    }
    const resolved = await resolveCliCommand("claude");

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFiles to work with:\n${fileList}`;
    }

    const args: string[] = [
      ...resolved.prefixArgs,
      "-p",
      fullPrompt,
      "--output-format",
      "json",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--permission-mode",
      "acceptEdits",
    ];
    if (opts.modelOverride) {
      args.push("--model", opts.modelOverride);
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    for await (const evt of streamSubprocess(resolved.command, args, subOpts)) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") {
          stdoutBuf.push(evt.chunk);
          yield { type: "stdout", chunk: evt.chunk };
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

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "claude_code",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    const parsed = parseClaudeJson(stdout);
    const output = parsed.text ?? (stdout.trim() || stderr.trim());

    const result: DispatchResult = {
      output,
      service: "claude_code",
      success: exitCode === 0,
      durationMs,
    };
    if (parsed.tokensUsed) result.tokensUsed = parsed.tokensUsed;
    if (exitCode !== 0) {
      result.error = stderr.trim() || `Exit code ${exitCode}`;
    }

    yield { type: "completion", result };
  }
}

interface ParsedClaudeOutput {
  text: string | null;
  tokensUsed?: { input: number; output: number };
}

function parseClaudeJson(raw: string): ParsedClaudeOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: null };
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { text: null };
  }

  if (!data || typeof data !== "object") {
    return { text: null };
  }

  const obj = data as ClaudeJsonResult;
  const textCandidate = obj.result ?? obj.response ?? obj.text;
  const text = typeof textCandidate === "string" ? textCandidate.trim() : null;

  const result: ParsedClaudeOutput = { text };

  if (
    obj.usage &&
    typeof obj.usage.input_tokens === "number" &&
    typeof obj.usage.output_tokens === "number"
  ) {
    result.tokensUsed = {
      input: obj.usage.input_tokens,
      output: obj.usage.output_tokens,
    };
  }

  return result;
}
