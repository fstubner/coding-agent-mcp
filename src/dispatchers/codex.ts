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
 */

import type { DispatchResult, QuotaInfo } from "../types.js";
import type { Dispatcher, DispatchOpts } from "./base.js";
import { runSubprocess } from "./shared/subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
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

export class CodexDispatcher implements Dispatcher {
  readonly id = "codex";

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    // Token-based pricing — no hard quota to proactively check. Deferred to R3.
    return { service: "codex", source: "unknown" };
  }

  async dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const resolved = resolveCliCommand("codex");
    if (!resolved) {
      return {
        output: "",
        service: "codex",
        success: false,
        error: "codex CLI not found",
      };
    }

    // Codex takes a positional prompt argument; inline file paths so the
    // agent is aware of them (Codex can read them via its own tools).
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
      // Codex takes a flag (not process cwd) to set its working directory.
      args.push("--cd", workingDir);
    }

    // Forward OPENAI_API_KEY if the caller set it in process.env.
    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["OPENAI_API_KEY"];
    if (apiKey) {
      extraEnv["OPENAI_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const sub = await runSubprocess({
      command: resolved.command,
      args,
      cwd: workingDir || undefined,
      timeoutMs,
      extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    });

    if (sub.timedOut) {
      return {
        output: sub.stdout,
        service: "codex",
        success: false,
        error: `Timed out after ${timeoutMs}ms`,
        durationMs: sub.durationMs,
      };
    }

    // Try stdout first; on Windows via `cmd /c` output can land on stderr.
    const parsed =
      parseCodexJsonLines(sub.stdout) ?? parseCodexJsonLines(sub.stderr);

    const parsedText = parsed?.text ?? "";
    const output = parsedText || sub.stdout.trim() || sub.stderr.trim();

    const result: DispatchResult = {
      output,
      service: "codex",
      success: sub.exitCode === 0,
      durationMs: sub.durationMs,
    };

    if (parsed?.tokensUsed) {
      result.tokensUsed = parsed.tokensUsed;
    }

    if (sub.exitCode !== 0) {
      result.error = sub.stderr.trim() || `Exit code ${sub.exitCode}`;
    }

    return result;
  }
}

interface ParsedCodexOutput {
  text: string;
  tokensUsed?: { input: number; output: number };
}

/**
 * Parse codex exec --json output (newline-delimited JSON events).
 *
 * Confirmed event shape (codex-rs/exec/src/exec_events.rs, ThreadEvent):
 *   {"type": "item.completed",
 *    "item": {"id": "...", "type": "agent_message", "text": "..."}}
 *
 * Also handles a generic "message" event shape as a fallback for newer CLI
 * versions. Usage fields are summed across all events that carry them.
 *
 * Returns null if no JSON lines parsed at all (so caller can fall back to
 * raw stdout). Returns a ParsedCodexOutput with empty text if lines parsed
 * but no message-bearing event was found.
 */
function parseCodexJsonLines(raw: string): ParsedCodexOutput | null {
  const lines = raw.split(/\r?\n/);
  let lastText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  let sawAnyJson = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      continue;
    }
    sawAnyJson = true;

    // Preferred: item.completed with agent_message item.
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

    // Fallback: a generic message event with a content string.
    if (event.type === "message" && event.message?.content) {
      lastText = event.message.content;
    }

    if (event.usage) {
      const inTok =
        event.usage.input_tokens ?? event.usage.prompt_tokens ?? 0;
      const outTok =
        event.usage.output_tokens ?? event.usage.completion_tokens ?? 0;
      if (inTok || outTok) {
        inputTokens += inTok;
        outputTokens += outTok;
        sawUsage = true;
      }
    }
  }

  if (!sawAnyJson) {
    return null;
  }

  const parsed: ParsedCodexOutput = { text: lastText.trim() };
  if (sawUsage) {
    parsed.tokensUsed = { input: inputTokens, output: outputTokens };
  }
  return parsed;
}
