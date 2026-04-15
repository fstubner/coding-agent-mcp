/**
 * Unit tests for `streamSubprocess` + `drainSubprocessStream`.
 *
 * Uses a real `node -e "..."` child for end-to-end verification — this is
 * the only place where we spawn real processes. Tests are hermetic because
 * the launched scripts complete in <100ms.
 */

import { describe, it, expect } from "vitest";
import { streamSubprocess, drainSubprocessStream } from "../../src/dispatchers/shared/stream-subprocess.js";

const NODE = process.execPath;

describe("streamSubprocess", () => {
  it("yields stdout chunks in order and emits a terminal end event", async () => {
    const script = `
      process.stdout.write('a');
      process.stdout.write('b');
      process.stdout.write('c');
    `;
    const events: Array<{ kind: string; chunk?: string; exitCode?: number }> = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if ("stream" in evt) {
        events.push({ kind: evt.stream, chunk: evt.chunk });
      } else {
        events.push({ kind: "end", exitCode: evt.exitCode });
      }
    }
    // stdout chunks may coalesce — require concatenation equals expected.
    const stdoutText = events
      .filter((e) => e.kind === "stdout")
      .map((e) => e.chunk ?? "")
      .join("");
    expect(stdoutText).toBe("abc");
    expect(events[events.length - 1]?.kind).toBe("end");
    expect(events[events.length - 1]?.exitCode).toBe(0);
  });

  it("separately captures stderr", async () => {
    const script = `
      process.stderr.write('err-chunk');
      process.stdout.write('out-chunk');
    `;
    const stdout: string[] = [];
    const stderr: string[] = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if ("stream" in evt) {
        if (evt.stream === "stdout") stdout.push(evt.chunk);
        else stderr.push(evt.chunk);
      }
    }
    expect(stdout.join("")).toBe("out-chunk");
    expect(stderr.join("")).toBe("err-chunk");
  });

  it("respects timeoutMs and terminates the child", async () => {
    const script = `
      // Sleep indefinitely so the timeout must fire.
      setInterval(() => {}, 10_000);
    `;
    const events: unknown[] = [];
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 200 })) {
      events.push(evt);
    }
    const terminal = events[events.length - 1] as {
      kind: string;
      timedOut: boolean;
    };
    expect(terminal.kind).toBe("end");
    expect(terminal.timedOut).toBe(true);
  }, 5_000);

  it("respects maxOutputBytes and truncates+kills the child", async () => {
    const script = `
      const buf = 'x'.repeat(1024);
      setInterval(() => process.stdout.write(buf), 5);
    `;
    let totalBytes = 0;
    for await (const evt of streamSubprocess(NODE, ["-e", script], {
      maxOutputBytes: 4096,
      timeoutMs: 5_000,
    })) {
      if ("stream" in evt) totalBytes += evt.chunk.length;
      else {
        expect(evt.truncated).toBe(true);
        break;
      }
    }
    // We yielded at most maxOutputBytes; may be slightly less due to chunking.
    expect(totalBytes).toBeLessThanOrEqual(4096);
  }, 10_000);

  it("closes the iterator when the consumer breaks early", async () => {
    const script = `
      let i = 0;
      const t = setInterval(() => {
        process.stdout.write('tick ' + (++i) + '\\n');
        if (i > 100) { clearInterval(t); process.exit(0); }
      }, 10);
    `;
    let count = 0;
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 5_000 })) {
      if ("stream" in evt) {
        count += 1;
        if (count >= 2) break; // early cancellation
      }
    }
    expect(count).toBeGreaterThanOrEqual(1);
    // If we reach this line, .return() worked and the subprocess was killed.
  }, 10_000);

  it("reports a non-zero exit code in the terminal event", async () => {
    const script = `process.exit(7);`;
    let terminal: { exitCode: number } | null = null;
    for await (const evt of streamSubprocess(NODE, ["-e", script])) {
      if (!("stream" in evt)) terminal = { exitCode: evt.exitCode };
    }
    expect(terminal?.exitCode).toBe(7);
  });

  it("yields chunks in real time (not all at the end)", async () => {
    // Slow producer: writes one chunk every 80ms. If streamSubprocess were
    // buffering until EOF, the observed timestamps would all bunch at the
    // end. Instead we expect at least two chunks with significant time gaps.
    const script = `
      let i = 0;
      const t = setInterval(() => {
        process.stdout.write('tick ' + (++i) + '\\n');
        if (i >= 4) { clearInterval(t); process.exit(0); }
      }, 80);
    `;
    const chunkTimestamps: number[] = [];
    const start = Date.now();
    for await (const evt of streamSubprocess(NODE, ["-e", script], { timeoutMs: 5_000 })) {
      if ("stream" in evt && evt.stream === "stdout") {
        chunkTimestamps.push(Date.now() - start);
      }
    }
    expect(chunkTimestamps.length).toBeGreaterThanOrEqual(2);
    // Between the first and the last chunk we should see > 100ms of wall
    // time — confirming real-time delivery (not all-at-once buffering).
    const first = chunkTimestamps[0]!;
    const last = chunkTimestamps[chunkTimestamps.length - 1]!;
    expect(last - first).toBeGreaterThan(100);
  }, 10_000);
});

describe("drainSubprocessStream", () => {
  it("buffers the stream into a SubprocessResult-like object", async () => {
    const script = `
      process.stdout.write('hello');
      process.stderr.write('world');
      process.exit(3);
    `;
    const res = await drainSubprocessStream(streamSubprocess(NODE, ["-e", script]));
    expect(res.stdout).toBe("hello");
    expect(res.stderr).toBe("world");
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });
});
