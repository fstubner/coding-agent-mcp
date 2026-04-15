/**
 * Dispatcher abstraction.
 *
 * Every backend (Claude Code CLI, Cursor, Codex, Gemini, OpenAI-compatible HTTP)
 * implements this. The router picks one via scoring; the MCP server awaits
 * `dispatch()` or iterates `stream()`.
 *
 * R3 change: `stream()` is now the canonical primitive. `dispatch()` is
 * implemented by consuming the stream and buffering its events — concrete
 * dispatchers can either inherit the default via `BaseDispatcher` or
 * override `dispatch()` directly when there's a buffered fast-path that's
 * worth preserving.
 */

import type { DispatchResult, DispatcherEvent, QuotaInfo } from "../types.js";

export interface DispatchOpts {
  modelOverride?: string;
  timeoutMs?: number;
}

export interface Dispatcher {
  readonly id: string;
  dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts?: DispatchOpts,
  ): Promise<DispatchResult>;
  stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts?: DispatchOpts,
  ): AsyncIterable<DispatcherEvent>;
  checkQuota(): Promise<QuotaInfo>;
  isAvailable(): boolean;
}

/**
 * Abstract helper that implements `dispatch()` on top of `stream()`.
 *
 * Concrete dispatchers only need to implement `stream()`, `checkQuota()`,
 * and `isAvailable()`. The default `dispatch()` consumes the stream,
 * captures the terminal `completion` or `error` event, and returns its
 * embedded `DispatchResult`.
 *
 * If a dispatcher has a buffered fast-path (e.g. the one-shot HTTP POST in
 * `OpenAICompatibleDispatcher`) it can override `dispatch()` directly.
 */
export abstract class BaseDispatcher implements Dispatcher {
  abstract readonly id: string;
  abstract stream(
    prompt: string,
    files: string[],
    workingDir: string,
    opts?: DispatchOpts,
  ): AsyncIterable<DispatcherEvent>;
  abstract checkQuota(): Promise<QuotaInfo>;
  abstract isAvailable(): boolean;

  async dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts: DispatchOpts = {},
  ): Promise<DispatchResult> {
    return drainDispatcherStream(this.stream(prompt, files, workingDir, opts), this.id);
  }
}

/**
 * Drain a dispatcher stream into a `DispatchResult`.
 *
 * The stream is guaranteed (by contract) to yield exactly one terminal
 * `completion` or `error` event. This helper captures the terminal event
 * and returns its embedded result, accumulating stdout/stderr chunks so
 * they survive even when the dispatcher forgets to set `result.output`
 * (shouldn't happen, but is a defensive fallback).
 */
export async function drainDispatcherStream(
  iter: AsyncIterable<DispatcherEvent>,
  fallbackService: string,
): Promise<DispatchResult> {
  let terminal: DispatchResult | null = null;
  let terminalError: string | null = null;
  const stdout: string[] = [];
  const stderr: string[] = [];
  for await (const event of iter) {
    switch (event.type) {
      case "stdout":
        stdout.push(event.chunk);
        break;
      case "stderr":
        stderr.push(event.chunk);
        break;
      case "completion":
        terminal = event.result;
        break;
      case "error":
        terminalError = event.error;
        break;
      // tool_use / thinking are informational; they don't affect the drained result.
      default:
        break;
    }
  }
  if (terminal) return terminal;
  if (terminalError !== null) {
    return {
      output: stdout.join("") || stderr.join(""),
      service: fallbackService,
      success: false,
      error: terminalError,
    };
  }
  return {
    output: stdout.join(""),
    service: fallbackService,
    success: false,
    error: "Dispatcher stream ended without a completion event",
  };
}
