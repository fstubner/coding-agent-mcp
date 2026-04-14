/**
 * Cross-platform CLI binary resolution.
 *
 * On Windows, CLI tools installed via npm/scoop/winget are typically `.cmd` or
 * `.bat` wrappers. Node's `spawn` cannot execute those directly without a
 * shell — attempting to do so throws ENOENT or silently fails on some systems.
 * The fix is to invoke them through `cmd /c <resolved path>`.
 *
 * On non-Windows (or when the binary resolves to a native executable), we just
 * return the resolved absolute path with no prefix args.
 *
 * NOTE: spaces in the resolved path are fine because `spawn` passes `args` as
 * a list — no shell parsing involved. On Windows, `cmd /c` still receives the
 * path as a single arg and handles it correctly.
 */

import path from "node:path";
import which from "which";

export interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
}

export async function resolveCliCommand(bin: string): Promise<ResolvedCommand> {
  const resolved = await which(bin, { nothrow: true });
  if (!resolved) {
    // Let spawn surface the ENOENT — caller may be running in a sandbox where
    // PATH resolution is deliberately stubbed.
    return { command: bin, prefixArgs: [] };
  }

  if (process.platform !== "win32") {
    return { command: resolved, prefixArgs: [] };
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return { command: "cmd", prefixArgs: ["/c", resolved] };
  }
  return { command: resolved, prefixArgs: [] };
}
