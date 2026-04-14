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
 * Quota: Reactive only. No proactive quota endpoint — deferred to R3.
 */

import type { DispatchResult, QuotaInfo } from "../types.js";
import type { Dispatcher, DispatchOpts } from "./base.js";
import { runSubprocess } from "./shared/subprocess.js";
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

export class ClaudeCodeDispatcher implements Dispatcher {
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

  async dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const resolved = resolveCliCommand("claude");
    if (!resolved) {
      return {
        output: "",
        service: "claude_code",
        success: false,
        error: "claude CLI not found",
      };
    }

    // Inline file paths in the prompt body — Claude's Read tool loads them.
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

    const sub = await runSubprocess({
      command: resolved.command,
      args,
      cwd: workingDir || undefined,
      timeoutMs,
      // Claude Code uses OAuth/keychain — no API key env var.
    });

    if (sub.timedOut) {
      return {
        output: sub.stdout,
        service: "claude_code",
        success: false,
        error: `Timed out after ${timeoutMs}ms`,
        durationMs: sub.durationMs,
      };
    }

    const parsed = parseClaudeJson(sub.stdout);
    const output =
      parsed.text ?? (sub.stdout.trim() || sub.stderr.trim());

    const result: DispatchResult = {
      output,
      service: "claude_code",
      success: sub.exitCode === 0,
      durationMs: sub.durationMs,
    };

    if (parsed.tokensUsed) {
      result.tokensUsed = parsed.tokensUsed;
    }

    if (sub.exitCode !== 0) {
      result.error = sub.stderr.trim() || `Exit code ${sub.exitCode}`;
    }

    return result;
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
