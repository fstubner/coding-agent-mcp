/**
 * Cursor headless CLI dispatcher for coding-agent-mcp.
 *
 * Dispatch:  agent -p --trust --workspace <dir> --output-format json "<prompt>"
 *                  [--model <override>]
 *
 *   agent is the Cursor headless CLI (installed via cursor.com/install). The
 *   command name is literally 'agent', not 'cursor'.
 *   -p / --print            Non-interactive, prints response and exits.
 *   --trust                 Skip the workspace-trust prompt (required for headless).
 *   --workspace <dir>       Set the workspace directory. Defaults to HOME when the
 *                           caller did not supply one — matches the Python reference.
 *   --output-format json    Emits a single JSON object with a top-level "result".
 *
 * Auth: reads CURSOR_API_KEY from process.env and forwards it to the subprocess.
 * Quota: no proactive quota endpoint; reactive only via circuit breaker.
 *
 * R3: stream()-first. The CLI emits one JSON object at the end of the run,
 * so stdout chunks are forwarded verbatim and `completion` fires once the
 * full blob has been parsed.
 */

import os from "node:os";
import which from "which";
import type { DispatchResult, DispatcherEvent, QuotaInfo } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface CursorJsonResult {
  result?: unknown;
  output?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class CursorDispatcher extends BaseDispatcher {
  readonly id = "cursor";

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "cursor", source: "unknown" };
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
    const foundPath = await which("agent", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "cursor",
          success: false,
          error: "agent CLI not found — install via cursor.com/install",
        },
      };
      return;
    }
    const resolved = await resolveCliCommand("agent");

    let fullPrompt = prompt;
    if (files.length > 0) {
      const fileList = files.map((p) => `  - ${p}`).join("\n");
      fullPrompt = `${prompt}\n\nFocus on these files:\n${fileList}`;
    }

    const effectiveDir = workingDir || os.homedir();

    const args: string[] = [
      ...resolved.prefixArgs,
      "-p",
      "--trust",
      "--workspace",
      effectiveDir,
      "--output-format",
      "json",
      fullPrompt,
    ];
    if (opts.modelOverride) {
      args.push("--model", opts.modelOverride);
    }

    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["CURSOR_API_KEY"];
    if (apiKey) {
      extraEnv["CURSOR_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const subOpts: Parameters<typeof streamSubprocess>[2] = {
      timeoutMs,
      cwd: effectiveDir,
    };
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

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
          service: "cursor",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    const parsed = parseCursorJson(stdout) ?? parseCursorJson(stderr);
    const parsedText = parsed?.text ?? null;

    if (exitCode === 0 && parsedText) {
      const result: DispatchResult = {
        output: parsedText,
        service: "cursor",
        success: true,
        durationMs,
      };
      if (parsed?.tokensUsed) result.tokensUsed = parsed.tokensUsed;
      yield { type: "completion", result };
      return;
    }

    // Error path — detect rate limit in combined output.
    const combined = `${stdout}\n${stderr}`;
    const { rateLimited, retryAfter } = detectRateLimit(combined);
    const errorDetail =
      stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;

    const result: DispatchResult = {
      output: parsedText ?? errorDetail,
      service: "cursor",
      success: false,
      error: errorDetail,
      durationMs,
    };
    if (rateLimited) {
      result.rateLimited = true;
      if (retryAfter !== null) result.retryAfter = retryAfter;
    }
    if (parsed?.tokensUsed) result.tokensUsed = parsed.tokensUsed;
    yield { type: "completion", result };
  }
}

interface ParsedCursorOutput {
  text: string | null;
  tokensUsed?: { input: number; output: number };
}

function parseCursorJson(raw: string): ParsedCursorOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = tryParseJsonObj(line);
    if (parsed) return parsed;
  }
  return tryParseJsonObj(trimmed) ?? { text: null };
}

function tryParseJsonObj(s: string): ParsedCursorOutput | null {
  let data: unknown;
  try {
    data = JSON.parse(s);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const obj = data as CursorJsonResult;
  const textCandidate = obj.result ?? obj.output ?? obj.text;
  const text =
    typeof textCandidate === "string" && textCandidate.length > 0
      ? textCandidate.trim()
      : null;

  const parsed: ParsedCursorOutput = { text };

  if (obj.usage) {
    const input = obj.usage.input_tokens ?? obj.usage.prompt_tokens;
    const output = obj.usage.output_tokens ?? obj.usage.completion_tokens;
    if (typeof input === "number" && typeof output === "number") {
      parsed.tokensUsed = { input, output };
    }
  }

  return parsed;
}

function detectRateLimit(text: string): {
  rateLimited: boolean;
  retryAfter: number | null;
} {
  const lowered = text.toLowerCase();
  const flagged =
    lowered.includes("rate limit") ||
    lowered.includes("too many requests") ||
    lowered.includes("quota exceeded") ||
    lowered.includes("ratelimiterror") ||
    text.includes("429");

  if (!flagged) return { rateLimited: false, retryAfter: null };

  const m = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = m?.[1] ? Number.parseFloat(m[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}
