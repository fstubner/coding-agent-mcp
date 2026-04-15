/**
 * Gemini CLI dispatcher for coding-agent-mcp.
 *
 * Dispatch:  gemini -p "<prompt>" [--file <path> ...] --output-format json
 *                   [--model <override>]
 *
 * Thinking level: Gemini CLI has no per-invocation flag for thinking level
 * (feature request: github.com/google-gemini/gemini-cli/issues/21974). The
 * Python reference works around this by patching
 *   ~/.gemini/settings.json → modelConfigs.generateContentConfig.thinkingLevel
 * around each dispatch. We reproduce that here using a zero-dependency
 * promise-chain mutex so concurrent dispatches (e.g. via code_mixture) cannot
 * stomp on each other's settings.
 *
 * Override ~/.gemini/settings.json path with GEMINI_SETTINGS_PATH env var
 * (used by tests).
 *
 * Auth:  GEMINI_API_KEY forwarded from process.env when present.
 * Quota: reactive only; deferred proactive check to a later revision.
 *
 * R3: stream()-first. The CLI emits one JSON blob at end-of-run so chunks
 * are forwarded verbatim; completion event parses the full buffer.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import which from "which";
import type {
  DispatchResult,
  DispatcherEvent,
  QuotaInfo,
  ServiceConfig,
  ThinkingLevel,
} from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { streamSubprocess } from "./shared/stream-subprocess.js";
import { resolveCliCommand } from "./shared/windows-cmd.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

const THINKING_MAP: Record<ThinkingLevel, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
};

interface GeminiJsonResponse {
  response?: unknown;
  text?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Module-level mutex: serialises concurrent Gemini dispatches so the settings
// patch/restore around each call cannot interleave. Zero dependencies.
// ---------------------------------------------------------------------------

let lockChain: Promise<void> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockChain;
  let release!: () => void;
  lockChain = new Promise<void>((r) => {
    release = r;
  });
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

export function _geminiLockIdle(): Promise<void> {
  return lockChain;
}

function settingsPath(): string {
  const override = process.env["GEMINI_SETTINGS_PATH"];
  if (override) return override;
  return path.join(os.homedir(), ".gemini", "settings.json");
}

async function withThinkingOverride<T>(
  level: ThinkingLevel | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!level) return fn();
  const mapped = THINKING_MAP[level];
  if (!mapped) return fn();

  return withLock(async () => {
    const file = settingsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });

    let originalText: string | null = null;
    let settings: Record<string, unknown> = {};
    try {
      originalText = await fs.readFile(file, "utf8");
      try {
        const parsed = JSON.parse(originalText) as unknown;
        if (parsed && typeof parsed === "object") {
          settings = parsed as Record<string, unknown>;
        }
      } catch {
        // Fall through with an empty settings object — we'll restore the
        // original text verbatim afterwards.
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") throw err;
    }

    const modelConfigs = getOrCreateObject(settings, "modelConfigs");
    const generateContentConfig = getOrCreateObject(
      modelConfigs,
      "generateContentConfig",
    );
    generateContentConfig["thinkingLevel"] = mapped;

    await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");

    try {
      return await fn();
    } finally {
      if (originalText !== null) {
        try {
          await fs.writeFile(file, originalText, "utf8");
        } catch {
          // best-effort restore
        }
      } else {
        try {
          const raw = await fs.readFile(file, "utf8");
          const restored = JSON.parse(raw) as Record<string, unknown>;
          const mc = restored["modelConfigs"];
          if (mc && typeof mc === "object") {
            const gcc = (mc as Record<string, unknown>)["generateContentConfig"];
            if (gcc && typeof gcc === "object") {
              delete (gcc as Record<string, unknown>)["thinkingLevel"];
            }
          }
          await fs.writeFile(file, JSON.stringify(restored, null, 2), "utf8");
        } catch {
          // best-effort cleanup
        }
      }
    }
  });
}

function getOrCreateObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export class GeminiDispatcher extends BaseDispatcher {
  readonly id = "gemini_cli";
  private readonly thinkingLevel: ThinkingLevel | undefined;
  private readonly configuredModel: string | undefined;

  constructor(svc?: ServiceConfig) {
    super();
    this.thinkingLevel = svc?.thinkingLevel;
    this.configuredModel = svc?.model;
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: "gemini_cli", source: "unknown" };
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
    const foundPath = await which("gemini", { nothrow: true });
    if (!foundPath) {
      yield {
        type: "completion",
        result: {
          output: "",
          service: "gemini_cli",
          success: false,
          error: "gemini CLI not found",
        },
      };
      return;
    }
    const resolved = await resolveCliCommand("gemini");

    const effectiveModel = opts.modelOverride ?? this.configuredModel;

    const args: string[] = [...resolved.prefixArgs];
    if (effectiveModel) {
      args.push("--model", effectiveModel);
    }
    args.push("-p", prompt, "--output-format", "json");
    for (const file of files) {
      args.push("--file", file);
    }

    const extraEnv: Record<string, string> = {};
    const apiKey = process.env["GEMINI_API_KEY"];
    if (apiKey) {
      extraEnv["GEMINI_API_KEY"] = apiKey;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const subOpts: Parameters<typeof streamSubprocess>[2] = { timeoutMs };
    if (workingDir) subOpts.cwd = workingDir;
    if (Object.keys(extraEnv).length > 0) subOpts.env = extraEnv;

    // withThinkingOverride wraps the subprocess invocation — we need to
    // collect the stream events during the lock-held region. Buffer them
    // here, then replay.
    const events: DispatcherEvent[] = [];
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    let exitCode = -1;
    let durationMs = 0;
    let timedOut = false;

    await withThinkingOverride(this.thinkingLevel, async () => {
      for await (const evt of streamSubprocess(resolved.command, args, subOpts)) {
        if ("stream" in evt) {
          if (evt.stream === "stdout") {
            stdoutBuf.push(evt.chunk);
            events.push({ type: "stdout", chunk: evt.chunk });
          } else {
            stderrBuf.push(evt.chunk);
            events.push({ type: "stderr", chunk: evt.chunk });
          }
        } else {
          exitCode = evt.exitCode;
          durationMs = evt.durationMs;
          timedOut = evt.timedOut;
        }
      }
    });

    for (const e of events) yield e;

    const stdout = stdoutBuf.join("");
    const stderr = stderrBuf.join("");

    if (timedOut) {
      yield {
        type: "completion",
        result: {
          output: stdout,
          service: "gemini_cli",
          success: false,
          error: `Timed out after ${timeoutMs}ms`,
          durationMs,
        },
      };
      return;
    }

    const parsed = parseGeminiJson(stdout) ?? parseGeminiJson(stderr);
    const parsedText = parsed?.text ?? "";

    if (exitCode === 0) {
      const output = parsedText || stdout.trim() || stderr.trim();
      const result: DispatchResult = {
        output,
        service: "gemini_cli",
        success: true,
        durationMs,
      };
      if (parsed?.tokensUsed) result.tokensUsed = parsed.tokensUsed;
      yield { type: "completion", result };
      return;
    }

    const combined = `${stdout}\n${stderr}`;
    const { rateLimited, retryAfter } = detectRateLimit(combined);
    const errorDetail =
      stderr.trim() || stdout.trim() || `Exit code ${exitCode}`;

    const result: DispatchResult = {
      output: parsedText || stdout.trim(),
      service: "gemini_cli",
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

interface ParsedGeminiOutput {
  text: string;
  tokensUsed?: { input: number; output: number };
}

function parseGeminiJson(raw: string): ParsedGeminiOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const obj = data as GeminiJsonResponse;
  const textCandidate = obj.response ?? obj.text;
  const text = typeof textCandidate === "string" ? textCandidate.trim() : "";

  const parsed: ParsedGeminiOutput = { text };

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
    lowered.includes("quota exceeded") ||
    lowered.includes("resource_exhausted") ||
    lowered.includes("too many requests") ||
    text.includes("429");

  if (!flagged) return { rateLimited: false, retryAfter: null };

  const m = /retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)/i.exec(text);
  const retryAfter = m?.[1] ? Number.parseFloat(m[1]) : null;
  return {
    rateLimited: true,
    retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
  };
}
