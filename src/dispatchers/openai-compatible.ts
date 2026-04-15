/**
 * OpenAI-compatible HTTP dispatcher for coding-agent-mcp.
 *
 * Handles any provider that speaks POST /v1/chat/completions:
 *   - Ollama        (http://localhost:11434/v1)
 *   - LM Studio     (http://localhost:1234/v1)
 *   - OpenRouter    (https://openrouter.ai/api/v1)
 *   - OpenAI API    (https://api.openai.com/v1)
 *   - Any other OpenAI-compatible endpoint
 *
 * Transport: global `fetch` (Node 24+). No subprocess, no extra deps.
 * Quota:     reactive — parses x-ratelimit-* headers on every response.
 *            Local endpoints (Ollama, LM Studio) have no rate limits.
 *
 * R3: `dispatch()` retains the buffered POST for simplicity + compatibility
 * with tests that mock `fetch`. `stream()` switches to SSE streaming by
 * setting `stream: true` in the request body and parsing `data: {...}`
 * chunks as they arrive. The `completion` event is built from the summed
 * delta content across all events.
 */

import type { DispatchResult, DispatcherEvent, QuotaInfo, ServiceConfig } from "../types.js";
import { BaseDispatcher, type DispatchOpts } from "./base.js";
import { parseRetryAfter } from "./shared/rate-limit-headers.js";

const CHAT_PATH = "/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert software engineer. " +
  "Respond with clear, working code and concise explanations.";
const _MAX_FILE_BYTES = 512 * 1024; // 512 KB per file

interface ChatChoice {
  message?: {
    content?: unknown;
    role?: unknown;
  };
  delta?: {
    content?: unknown;
    role?: unknown;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: unknown;
    type?: unknown;
  };
}

export class OpenAICompatibleDispatcher extends BaseDispatcher {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly thinkingLevel?: string | undefined;

  constructor(svc: ServiceConfig) {
    super();
    this.id = svc.name;
    const base = svc.baseUrl ?? "";
    this.baseUrl = base.replace(/\/+$/, "");
    this.model = svc.model ?? "";
    this.apiKey = svc.apiKey ?? "";
    if (svc.thinkingLevel) this.thinkingLevel = svc.thinkingLevel;
  }

  isAvailable(): boolean {
    return true;
  }

  async checkQuota(): Promise<QuotaInfo> {
    return { service: this.id, source: "unknown" };
  }

  /**
   * Buffered one-shot: POST with stream=false, parse a single JSON body.
   * Kept as a fast-path (no incremental parsing overhead) and to preserve
   * existing mocked-fetch tests.
   */
  override async dispatch(
    prompt: string,
    files: string[],
    _workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    const start = Date.now();
    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = `${this.baseUrl}${CHAT_PATH}`;

    const model = opts.modelOverride ?? this.model;

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: fullPrompt },
      ],
      stream: false,
    };
    if (this.thinkingLevel) {
      body["reasoning_effort"] = this.thinkingLevel.toLowerCase();
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      return {
        output: "",
        service: this.id,
        success: false,
        error: aborted ? `Timed out after ${timeoutMs}ms` : errMsg,
        durationMs: Date.now() - start,
      };
    }
    clearTimeout(timer);

    const responseHeaders = headersToObject(res.headers);
    const durationMs = Date.now() - start;

    let parsedBody: ChatCompletionResponse | null = null;
    let rawBody = "";
    try {
      rawBody = await res.text();
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody) as ChatCompletionResponse;
        } catch {
          parsedBody = null;
        }
      }
    } catch {
      // Body read failed — treat as empty.
    }

    if (res.status === 429) {
      const retryAfter = parseRetryAfter(responseHeaders);
      const result: DispatchResult = {
        output: "",
        service: this.id,
        success: false,
        error: `Rate limited by ${this.id}`,
        rateLimited: true,
        rateLimitHeaders: responseHeaders,
        durationMs,
      };
      if (retryAfter !== null) result.retryAfter = retryAfter;
      return result;
    }

    if (res.status >= 400) {
      const errMessage = extractErrorMessage(parsedBody, rawBody);
      return {
        output: "",
        service: this.id,
        success: false,
        error: `HTTP ${res.status}: ${errMessage}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const content = parsedBody ? extractContent(parsedBody) : null;
    if (content === null) {
      return {
        output: "",
        service: this.id,
        success: false,
        error: `Unexpected response shape: ${rawBody.slice(0, 300)}`,
        durationMs,
        rateLimitHeaders: responseHeaders,
      };
    }

    const result: DispatchResult = {
      output: content,
      service: this.id,
      success: true,
      durationMs,
      rateLimitHeaders: responseHeaders,
    };

    if (parsedBody?.usage) {
      const input = parsedBody.usage.prompt_tokens;
      const output = parsedBody.usage.completion_tokens;
      if (typeof input === "number" && typeof output === "number") {
        result.tokensUsed = { input, output };
      }
    }

    return result;
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
    _workingDir: string,
    opts: DispatchOpts,
  ): AsyncGenerator<DispatcherEvent> {
    const start = Date.now();
    const fullPrompt = await buildPromptWithFiles(prompt, files);
    const url = `${this.baseUrl}${CHAT_PATH}`;
    const model = opts.modelOverride ?? this.model;

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        { role: "user", content: fullPrompt },
      ],
      stream: true,
    };
    if (this.thinkingLevel) body["reasoning_effort"] = this.thinkingLevel.toLowerCase();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      const aborted = (err as { name?: string } | null)?.name === "AbortError";
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: aborted ? `Timed out after ${timeoutMs}ms` : errMsg,
          durationMs: Date.now() - start,
        },
      };
      return;
    }

    const responseHeaders = headersToObject(res.headers);

    if (res.status === 429) {
      clearTimeout(timer);
      const retryAfter = parseRetryAfter(responseHeaders);
      const result: DispatchResult = {
        output: "",
        service: this.id,
        success: false,
        error: `Rate limited by ${this.id}`,
        rateLimited: true,
        rateLimitHeaders: responseHeaders,
        durationMs: Date.now() - start,
      };
      if (retryAfter !== null) result.retryAfter = retryAfter;
      yield { type: "completion", result };
      return;
    }

    if (res.status >= 400) {
      clearTimeout(timer);
      const rawBody = await res.text().catch(() => "");
      let parsedBody: ChatCompletionResponse | null = null;
      try {
        parsedBody = JSON.parse(rawBody) as ChatCompletionResponse;
      } catch {
        parsedBody = null;
      }
      const errMessage = extractErrorMessage(parsedBody, rawBody);
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: `HTTP ${res.status}: ${errMessage}`,
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }

    // Stream body — SSE frames are `data: {json}\n\n` with a sentinel
    // `data: [DONE]`. We decode UTF-8 chunks and split on `\n\n`.
    const chunks: string[] = [];
    let buffer = "";
    let usage: { input: number; output: number } | null = null;

    if (!res.body) {
      clearTimeout(timer);
      yield {
        type: "completion",
        result: {
          output: "",
          service: this.id,
          success: false,
          error: "No response body",
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const evts = this.#parseSseFrame(frame);
          for (const e of evts.events) {
            yield e;
            if (e.type === "stdout") chunks.push(e.chunk);
          }
          if (evts.usage) usage = evts.usage;
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      clearTimeout(timer);
      const errMsg = err instanceof Error ? err.message : String(err);
      yield {
        type: "completion",
        result: {
          output: chunks.join(""),
          service: this.id,
          success: false,
          error: errMsg,
          durationMs: Date.now() - start,
          rateLimitHeaders: responseHeaders,
        },
      };
      return;
    }
    clearTimeout(timer);

    // Flush trailing frame if any.
    if (buffer.trim()) {
      const evts = this.#parseSseFrame(buffer);
      for (const e of evts.events) {
        yield e;
        if (e.type === "stdout") chunks.push(e.chunk);
      }
      if (evts.usage) usage = evts.usage;
    }

    const output = chunks.join("");
    const result: DispatchResult = {
      output,
      service: this.id,
      success: true,
      durationMs: Date.now() - start,
      rateLimitHeaders: responseHeaders,
    };
    if (usage) result.tokensUsed = usage;
    yield { type: "completion", result };
  }

  /**
   * Parse one `data: {...}` SSE frame into DispatcherEvents. Returns an
   * events array + optional usage object (usage arrives on the final
   * frame in the OpenAI spec).
   */
  #parseSseFrame(frame: string): {
    events: DispatcherEvent[];
    usage: { input: number; output: number } | null;
  } {
    const out: DispatcherEvent[] = [];
    let usage: { input: number; output: number } | null = null;
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload === "[DONE]") continue;
      let obj: ChatCompletionResponse;
      try {
        obj = JSON.parse(payload) as ChatCompletionResponse;
      } catch {
        continue;
      }
      const choices = obj.choices;
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const delta = c.delta ?? c.message;
          const content = delta?.content;
          if (typeof content === "string" && content.length > 0) {
            out.push({ type: "stdout", chunk: content });
          }
        }
      }
      if (obj.usage) {
        const input = obj.usage.prompt_tokens;
        const output = obj.usage.completion_tokens;
        if (typeof input === "number" && typeof output === "number") {
          usage = { input, output };
        }
      }
    }
    return { events: out, usage };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function extractContent(body: ChatCompletionResponse): string | null {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const msg = first.message;
  if (!msg || typeof msg !== "object") return null;
  const content = (msg as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function extractErrorMessage(
  body: ChatCompletionResponse | null,
  rawBody: string,
): string {
  if (body?.error) {
    if (typeof body.error.message === "string") return body.error.message;
  }
  return rawBody.slice(0, 200) || "(empty body)";
}

async function buildPromptWithFiles(
  prompt: string,
  files: string[],
): Promise<string> {
  if (files.length === 0) return prompt;
  const parts: string[] = [prompt];
  const { stat, readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        parts.push(`\n# Not a file: ${filePath}`);
        continue;
      }
      if (info.size > _MAX_FILE_BYTES) {
        parts.push(
          `\n# Skipped ${filePath}: file too large (${Math.floor(
            info.size / 1024,
          )} KB > ${_MAX_FILE_BYTES / 1024} KB limit)`,
        );
        continue;
      }
      const content = await readFile(filePath, "utf8");
      const ext = extname(filePath).replace(/^\./, "");
      parts.push(`\n\n\`\`\`${ext}\n# ${filePath}\n${content}\n\`\`\``);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        parts.push(`\n# File not found: ${filePath}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        parts.push(`\n# Could not read ${filePath}: ${msg}`);
      }
    }
  }
  return parts.join("\n");
}
