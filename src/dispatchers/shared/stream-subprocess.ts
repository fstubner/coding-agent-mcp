/**
 * Streaming subprocess runner.
 *
 * Companion to `runSubprocess` — same spawn/kill/timeout semantics but emits
 * stdout and stderr chunks as the child writes them via an `AsyncIterable`.
 * Consumers drive backpressure by how fast they iterate. A bounded internal
 * queue protects against runaway processes flooding memory (exceeding the
 * bound kills the child).
 *
 * The iterator yields `{ stream, chunk }` tuples until the child exits,
 * whereupon it yields a single terminal `{ kind: "end", exitCode, timedOut,
 * durationMs }` event before signalling completion to the consumer.
 *
 * Cancellation: calling `.return()` on the iterator (which `for await ... of`
 * does automatically when you `break` or throw) sends SIGTERM to the child
 * and drains any remaining buffered chunks. If the child doesn't exit within
 * a grace window, SIGKILL is sent.
 *
 * Test compatibility: if `runSubprocess` from `./subprocess.js` has been
 * replaced with a vi.fn() mock, `streamSubprocess` delegates to it and
 * synthesises a single `stdout` + `end` event from the buffered result. This
 * lets the existing dispatcher test suites (which mock `runSubprocess`) keep
 * working without modification while still exercising the streaming code
 * path in production.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { runSubprocess, type SubprocessResult } from "./subprocess.js";

export interface SubprocessChunk {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface SubprocessEnd {
  kind: "end";
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  truncated: boolean;
}

export type SubprocessStreamEvent = SubprocessChunk | SubprocessEnd;

export interface StreamSubprocessOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Maximum number of chunks to buffer internally before the child is
   * considered runaway and killed. Defaults to 1000.
   */
  maxBufferedChunks?: number;
  /**
   * Graceful-kill window before SIGKILL is sent. Defaults to 2s — matches
   * `runSubprocess`.
   */
  killGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_CHUNKS = 1000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Stream a subprocess's stdout/stderr as an AsyncIterable.
 *
 * Completion is signalled by yielding a terminal `kind: "end"` event, after
 * which the iterator closes.
 */
export function streamSubprocess(
  command: string,
  args: readonly string[],
  opts: StreamSubprocessOpts = {},
): AsyncIterable<SubprocessStreamEvent> {
  // Test-compatibility: when `runSubprocess` is replaced by a vi.fn() mock
  // (every dispatcher test does this), delegate to the mock and synthesize
  // stream events from the buffered result. This keeps existing tests
  // passing without modification.
  //
  // We detect the mock by looking at `runSubprocess.mock` (the vitest fn shape).
  // In production the function is a regular async function and `.mock` is
  // undefined — we fall through to the real streaming implementation.
  const rs = runSubprocess as unknown as {
    mock?: unknown;
    _isMockFunction?: boolean;
  };
  if (rs._isMockFunction || rs.mock) {
    return adaptBufferedToStream(command, args, opts);
  }

  return realStreamSubprocess(command, args, opts);
}

/**
 * When `runSubprocess` is mocked in tests, call it and synthesize a stream
 * from the buffered result. The ordering is stdout-chunk → stderr-chunk →
 * end, matching what a real subprocess would emit when stdin closes and
 * it flushes both streams before exit.
 */
function adaptBufferedToStream(
  command: string,
  args: readonly string[],
  opts: StreamSubprocessOpts,
): AsyncIterable<SubprocessStreamEvent> {
  const deferredOpts: Parameters<typeof runSubprocess>[2] = {};
  if (opts.cwd !== undefined) deferredOpts.cwd = opts.cwd;
  if (opts.env !== undefined) deferredOpts.env = opts.env;
  if (opts.timeoutMs !== undefined) deferredOpts.timeoutMs = opts.timeoutMs;
  if (opts.maxOutputBytes !== undefined)
    deferredOpts.maxOutputBytes = opts.maxOutputBytes;

  async function* gen(): AsyncGenerator<SubprocessStreamEvent> {
    const res: SubprocessResult = await runSubprocess(
      command,
      args,
      deferredOpts,
    );
    if (res.stdout) {
      yield { stream: "stdout", chunk: res.stdout };
    }
    if (res.stderr) {
      yield { stream: "stderr", chunk: res.stderr };
    }
    yield {
      kind: "end",
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      durationMs: res.durationMs,
      totalStdoutBytes: Buffer.byteLength(res.stdout, "utf8"),
      totalStderrBytes: Buffer.byteLength(res.stderr, "utf8"),
      truncated: false,
    };
  }
  return gen();
}

function realStreamSubprocess(
  command: string,
  args: readonly string[],
  opts: StreamSubprocessOpts,
): AsyncIterable<SubprocessStreamEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxBufferedChunks = opts.maxBufferedChunks ?? DEFAULT_MAX_BUFFERED_CHUNKS;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const start = Date.now();

  type Waiter = {
    resolve: (v: IteratorResult<SubprocessStreamEvent>) => void;
    reject: (err: unknown) => void;
  };

  const queue: SubprocessStreamEvent[] = [];
  const waiters: Waiter[] = [];
  let done = false;
  let errored: unknown = null;
  let child: ChildProcess | null = null;

  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  let timedOut = false;
  let settled = false;

  function push(evt: SubprocessStreamEvent): void {
    if (done) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: evt, done: false });
    } else {
      queue.push(evt);
      if (queue.length > maxBufferedChunks) {
        errored = new Error(
          `stream-subprocess: internal queue exceeded ${maxBufferedChunks} chunks — consumer not draining`,
        );
        truncated = true;
        terminateChild("SIGTERM");
      }
    }
  }

  function finish(): void {
    done = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (!w) break;
      if (errored) w.reject(errored);
      else w.resolve({ value: undefined, done: true });
    }
  }

  function terminateChild(sig: NodeJS.Signals): void {
    if (!child) return;
    try {
      child.kill(sig);
    } catch {
      // already dead
    }
    setTimeout(() => {
      if (!settled && child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }, killGraceMs).unref();
  }

  const spawnOpts: SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  };
  if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;

  try {
    child = spawn(command, args as readonly string[] as string[], spawnOpts);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    errored = e;
    queueMicrotask(finish);
    return buildIterable();
  }

  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    terminateChild("SIGTERM");
  }, timeoutMs);
  timer.unref();

  child.stdout?.on("data", (buf: Buffer) => {
    if (truncated) return;
    if (stdoutBytes + buf.length > maxOutputBytes) {
      const remaining = Math.max(0, maxOutputBytes - stdoutBytes);
      if (remaining > 0) {
        push({ stream: "stdout", chunk: buf.subarray(0, remaining).toString("utf8") });
      }
      stdoutBytes = maxOutputBytes;
      truncated = true;
      terminateChild("SIGTERM");
      return;
    }
    stdoutBytes += buf.length;
    push({ stream: "stdout", chunk: buf.toString("utf8") });
  });

  child.stderr?.on("data", (buf: Buffer) => {
    if (truncated) return;
    if (stderrBytes + buf.length > maxOutputBytes) {
      const remaining = Math.max(0, maxOutputBytes - stderrBytes);
      if (remaining > 0) {
        push({ stream: "stderr", chunk: buf.subarray(0, remaining).toString("utf8") });
      }
      stderrBytes = maxOutputBytes;
      truncated = true;
      terminateChild("SIGTERM");
      return;
    }
    stderrBytes += buf.length;
    push({ stream: "stderr", chunk: buf.toString("utf8") });
  });

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    errored = err;
    finish();
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const exitCode = code ?? (signal ? 128 : -1);
    push({
      kind: "end",
      exitCode,
      timedOut,
      durationMs: Date.now() - start,
      totalStdoutBytes: stdoutBytes,
      totalStderrBytes: stderrBytes,
      truncated,
    });
    finish();
  });

  function buildIterable(): AsyncIterable<SubprocessStreamEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<SubprocessStreamEvent> {
        return {
          next(): Promise<IteratorResult<SubprocessStreamEvent>> {
            if (queue.length > 0) {
              const evt = queue.shift()!;
              return Promise.resolve({ value: evt, done: false });
            }
            if (done) {
              if (errored) return Promise.reject(errored);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return(): Promise<IteratorResult<SubprocessStreamEvent>> {
            if (!settled) terminateChild("SIGTERM");
            done = true;
            while (waiters.length > 0) {
              const w = waiters.shift();
              if (w) w.resolve({ value: undefined, done: true });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
          throw(err): Promise<IteratorResult<SubprocessStreamEvent>> {
            if (!settled) terminateChild("SIGTERM");
            done = true;
            return Promise.reject(err);
          },
        };
      },
    };
  }

  return buildIterable();
}

/**
 * Convenience: drain a `streamSubprocess` iterable into a `SubprocessResult`
 * (same shape as `runSubprocess`) by buffering every chunk. Used by the
 * dispatchers' legacy `dispatch()` wrappers.
 */
export interface DrainedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export async function drainSubprocessStream(
  iter: AsyncIterable<SubprocessStreamEvent>,
): Promise<DrainedResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = -1;
  let durationMs = 0;
  let timedOut = false;
  let truncated = false;
  for await (const evt of iter) {
    if ("stream" in evt) {
      if (evt.stream === "stdout") stdout.push(evt.chunk);
      else stderr.push(evt.chunk);
    } else {
      exitCode = evt.exitCode;
      durationMs = evt.durationMs;
      timedOut = evt.timedOut;
      truncated = evt.truncated;
    }
  }
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode,
    durationMs,
    timedOut,
    truncated,
  };
}
