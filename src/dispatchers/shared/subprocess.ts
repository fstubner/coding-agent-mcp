/**
 * Async subprocess runner.
 *
 * Wraps `child_process.spawn` with:
 * - hard timeout (SIGTERM, then SIGKILL after grace period)
 * - output byte cap (protects the agent from pathological CLI output)
 * - DEVNULL stdin by default (prevents interactive auth prompts from hanging)
 * - UTF-8 decoding with replacement on invalid sequences
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface RunSubprocessOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

export function runSubprocess(
  command: string,
  args: readonly string[],
  opts: RunSubprocessOpts = {},
): Promise<SubprocessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    };
    if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;

    let child: ChildProcess;
    try {
      child = spawn(command, args as readonly string[] as string[], spawnOpts);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const appendStdout = (chunk: Buffer): void => {
      if (truncated) return;
      if (stdoutBytes + chunk.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxOutputBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    };

    const appendStderr = (chunk: Buffer): void => {
      if (truncated) return;
      if (stderrBytes + chunk.length > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - stderrBytes);
        if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes = maxOutputBytes;
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    };

    child.stdout?.on("data", (chunk: Buffer) => appendStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendStderr(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Force-kill if the child ignores SIGTERM.
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }
      }, KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}
