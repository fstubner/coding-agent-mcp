import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock `which` so we can control what the resolver sees without depending on
// what's actually installed on the test machine.
vi.mock("which", () => ({
  default: vi.fn(),
}));

import which from "which";
import { resolveCliCommand } from "../src/dispatchers/shared/windows-cmd.js";

const mockedWhich = which as unknown as ReturnType<typeof vi.fn>;

const originalPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  mockedWhich.mockReset();
});

describe("resolveCliCommand — non-Windows", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  it("returns the resolved absolute path with no prefix for a plain binary", async () => {
    mockedWhich.mockResolvedValueOnce("/usr/local/bin/claude");
    const result = await resolveCliCommand("claude");
    expect(result).toEqual({ command: "/usr/local/bin/claude", prefixArgs: [] });
  });

  it("does not wrap .cmd files on non-Windows (the extension is just a name there)", async () => {
    mockedWhich.mockResolvedValueOnce("/opt/bin/cursor.cmd");
    const result = await resolveCliCommand("cursor");
    expect(result).toEqual({ command: "/opt/bin/cursor.cmd", prefixArgs: [] });
  });

  it("falls back to the raw bin name if `which` returns null", async () => {
    mockedWhich.mockResolvedValueOnce(null);
    const result = await resolveCliCommand("nonexistent");
    expect(result).toEqual({ command: "nonexistent", prefixArgs: [] });
  });
});

describe("resolveCliCommand — Windows", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  it("wraps .cmd wrappers with `cmd /c`", async () => {
    mockedWhich.mockResolvedValueOnce(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd",
    );
    const result = await resolveCliCommand("claude");
    expect(result).toEqual({
      command: "cmd",
      prefixArgs: ["/c", "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd"],
    });
  });

  it("wraps .bat wrappers with `cmd /c`", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\gemini.bat");
    const result = await resolveCliCommand("gemini");
    expect(result).toEqual({
      command: "cmd",
      prefixArgs: ["/c", "C:\\Tools\\gemini.bat"],
    });
  });

  it("is case-insensitive on the extension (.CMD / .BAT)", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Tools\\x.CMD");
    const result = await resolveCliCommand("x");
    expect(result.command).toBe("cmd");
    expect(result.prefixArgs[0]).toBe("/c");
  });

  it("handles paths containing spaces correctly (arg is passed through as a single element)", async () => {
    mockedWhich.mockResolvedValueOnce(
      "C:\\Program Files\\My Tools\\codex.cmd",
    );
    const result = await resolveCliCommand("codex");
    expect(result).toEqual({
      command: "cmd",
      prefixArgs: ["/c", "C:\\Program Files\\My Tools\\codex.cmd"],
    });
    // critical: the path with spaces must be a single argv element, not split
    expect(result.prefixArgs).toHaveLength(2);
  });

  it("does NOT wrap native .exe executables", async () => {
    mockedWhich.mockResolvedValueOnce("C:\\Windows\\System32\\python.exe");
    const result = await resolveCliCommand("python");
    expect(result).toEqual({
      command: "C:\\Windows\\System32\\python.exe",
      prefixArgs: [],
    });
  });

  it("does not wrap extensionless resolved paths", async () => {
    // Unusual on Windows but guard against it.
    mockedWhich.mockResolvedValueOnce("C:\\tools\\weirdbin");
    const result = await resolveCliCommand("weirdbin");
    expect(result.prefixArgs).toEqual([]);
  });

  it("returns raw bin name when `which` cannot resolve", async () => {
    mockedWhich.mockResolvedValueOnce(null);
    const result = await resolveCliCommand("missing");
    expect(result).toEqual({ command: "missing", prefixArgs: [] });
  });
});
