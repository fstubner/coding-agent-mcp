/**
 * Dispatcher factory — shared between the CLI (`bin.ts`) and the MCP server.
 *
 * Ported from the Python `server.py:_build_dispatchers`. Uses dynamic imports
 * for every dispatcher module so that this branch (R2 Agent A — MCP surface)
 * compiles on its own, even before R2 Agent B's Cursor / Gemini CLI /
 * OpenAI-compatible dispatchers land on `main`. The factory simply skips any
 * harness whose module or export can't be resolved at runtime.
 */

import type { Dispatcher } from "../dispatchers/base.js";
import type { RouterConfig, ServiceConfig } from "../types.js";

/** Map of enabled service name -> dispatcher instance. */
export type DispatcherMap = Record<string, Dispatcher>;

type DispatcherCtor = new (svc: ServiceConfig) => Dispatcher;

/**
 * Lazily load a dispatcher module by relative path.
 *
 * Uses a variable specifier + `@ts-ignore` because some modules are owned by a
 * sibling agent and won't exist on this branch yet. Missing modules return
 * `undefined` so the caller can skip cleanly.
 */
async function loadDispatcherModule(
  relPath: string,
): Promise<Record<string, DispatcherCtor> | undefined> {
  try {
    // @ts-ignore - dynamic specifier; modules land at merge time.
    const mod = (await import(relPath)) as Record<string, DispatcherCtor>;
    return mod;
  } catch {
    return undefined;
  }
}

/**
 * Keys are canonical harness names. A service's harness is resolved as
 * `svc.harness ?? name` — which allows multiple services to share the same
 * CLI harness with different model strings (e.g. cursor_sonnet + cursor_opus
 * both using the "cursor" harness).
 */
const HARNESS_TABLE: Record<string, { path: string; exportName: string }> = {
  claude_code: {
    path: "../dispatchers/claude-code.js",
    exportName: "ClaudeCodeDispatcher",
  },
  codex: {
    path: "../dispatchers/codex.js",
    exportName: "CodexDispatcher",
  },
  // R2 Agent B landed Cursor / Gemini / OpenAI-compatible on `main`.
  // Filename + class name match what's actually on disk.
  cursor: {
    path: "../dispatchers/cursor.js",
    exportName: "CursorDispatcher",
  },
  gemini_cli: {
    path: "../dispatchers/gemini.js",
    exportName: "GeminiDispatcher",
  },
  gemini: {
    path: "../dispatchers/gemini.js",
    exportName: "GeminiDispatcher",
  },
};

/** Build one dispatcher from a service config. Returns undefined on failure. */
export async function makeDispatcher(
  name: string,
  svc: ServiceConfig,
): Promise<Dispatcher | undefined> {
  if (svc.type === "openai_compatible") {
    const mod = await loadDispatcherModule("../dispatchers/openai-compatible.js");
    const Ctor =
      mod?.OpenAiCompatibleDispatcher ??
      mod?.OpenAICompatibleDispatcher ??
      mod?.default;
    if (Ctor) return new Ctor(svc);
    return undefined;
  }

  const harness = svc.harness ?? name;
  const entry = HARNESS_TABLE[harness];
  if (!entry) return undefined;
  const mod = await loadDispatcherModule(entry.path);
  const Ctor = mod?.[entry.exportName];
  if (!Ctor) return undefined;
  return new Ctor(svc);
}

/**
 * Build a dispatcher map for every enabled service in the config.
 *
 * Services without a resolvable dispatcher module are quietly skipped — the
 * router never sees them. That mirrors Python's behaviour: harnesses for which
 * the CLI isn't installed (or whose wrapper module hasn't been merged yet) are
 * simply absent from the map, not failed-at-construction.
 */
export async function buildDispatchers(config: RouterConfig): Promise<DispatcherMap> {
  const out: DispatcherMap = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (!svc.enabled) continue;
    const d = await makeDispatcher(name, svc);
    if (d) out[name] = d;
  }
  return out;
}
