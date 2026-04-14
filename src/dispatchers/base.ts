/**
 * Dispatcher abstraction.
 *
 * Every backend (Claude Code CLI, Cursor, Codex, Gemini, OpenAI-compatible HTTP)
 * implements this. The router picks one via scoring; the MCP server awaits
 * `dispatch()` or iterates `stream()`.
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
  stream?(
    prompt: string,
    files: string[],
    workingDir: string,
    opts?: DispatchOpts,
  ): AsyncIterable<DispatcherEvent>;
  checkQuota(): Promise<QuotaInfo>;
  isAvailable(): boolean;
}
