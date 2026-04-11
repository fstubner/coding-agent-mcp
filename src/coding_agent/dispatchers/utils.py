"""Shared utilities for coding-agent dispatchers."""

import asyncio
import os
import re
import shutil
import sys
import time

# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

def _resolve_cmd(cmd: tuple[str, ...]) -> tuple[str, ...]:
    """
    On Windows, CLI tools installed via npm/scoop/winget are typically .cmd or
    .bat wrappers. asyncio.create_subprocess_exec cannot run those directly —
    they need to be invoked via 'cmd /c'.

    This function checks if the first token resolves to a .cmd/.bat file and
    prepends 'cmd /c' accordingly so the call works on Windows.
    """
    if sys.platform != "win32" or not cmd:
        return cmd

    exe = cmd[0]
    resolved = shutil.which(exe)
    if resolved and os.path.splitext(resolved)[1].lower() in (".cmd", ".bat"):
        return ("cmd", "/c") + cmd

    return cmd

async def run_subprocess(
    *cmd: str,
    timeout: int,
    cwd: str | None = None,
    stdin_data: bytes | None = None,
    extra_env: dict | None = None,
) -> tuple[int, str, str]:
    """Run a subprocess. Returns (returncode, stdout, stderr)."""
    env = None
    if extra_env:
        # If extra_env already looks like a full environment (has PATH), use it
        # directly. Otherwise merge on top of os.environ.
        if "PATH" in extra_env:
            env = extra_env
        else:
            env = {**os.environ, **extra_env}

    resolved_cmd = _resolve_cmd(cmd)

    proc = await asyncio.create_subprocess_exec(
        *resolved_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # DEVNULL stdin prevents interactive prompts (auth flows, confirmations)
        # from hanging the process indefinitely. Explicit stdin_data overrides this.
        stdin=asyncio.subprocess.PIPE if stdin_data else asyncio.subprocess.DEVNULL,
        cwd=cwd or None,
        env=env,
    )
    stdout, stderr = await asyncio.wait_for(
        proc.communicate(input=stdin_data), timeout=timeout
    )
    return (
        proc.returncode,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )

# ---------------------------------------------------------------------------
# Text parsers
# ---------------------------------------------------------------------------

def find_int(text: str, pattern: str) -> int | None:
    m = re.search(pattern, text, re.IGNORECASE)
    if not m:
        return None
    # Strip commas from numbers like "1,234,567"
    return int(m.group(1).replace(",", ""))

def find_str(text: str, pattern: str) -> str | None:
    m = re.search(pattern, text, re.IGNORECASE)
    return m.group(1) if m else None

# ---------------------------------------------------------------------------
# HTTP header parsers
# ---------------------------------------------------------------------------

def parse_retry_after(headers: dict) -> float | None:
    """
    Extract retry-after duration in seconds from response headers.
    Handles: Retry-After (seconds), x-ratelimit-reset-* (ISO timestamps or epoch).
    """
    # Direct seconds value
    raw = (
        headers.get("retry-after")
        or headers.get("Retry-After")
        or headers.get("x-ratelimit-retry-after")
    )
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass

    # Epoch timestamp
    for key in ("x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        val = headers.get(key) or headers.get(key.title())
        if val:
            try:
                reset_epoch = float(val)
                delay = reset_epoch - time.time()
                return max(0.0, delay)
            except ValueError:
                pass

    return None

def parse_remaining(headers: dict) -> int | None:
    """Extract remaining quota from response headers."""
    for key in (
        "x-ratelimit-remaining-requests",
        "x-ratelimit-remaining",
        "ratelimit-remaining",
    ):
        val = headers.get(key) or headers.get(key.title())
        if val is not None:
            try:
                return int(val)
            except ValueError:
                pass
    return None

def parse_limit(headers: dict) -> int | None:
    """Extract total quota limit from response headers."""
    for key in (
        "x-ratelimit-limit-requests",
        "x-ratelimit-limit",
        "ratelimit-limit",
    ):
        val = headers.get(key) or headers.get(key.title())
        if val is not None:
            try:
                return int(val)
            except ValueError:
                pass
    return None

# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

_MAX_FILE_BYTES = 512 * 1024  # 512 KB per file — prevents OOM on binary/generated files

def build_prompt_with_files(prompt: str, files: list[str]) -> str:
    """Inline file contents as fenced code blocks for CLIs that don't accept --file."""
    parts = [prompt]
    for path in files:
        if not os.path.isfile(path):
            parts.append(f"\n# File not found: {path}")
            continue
        try:
            size = os.path.getsize(path)
            if size > _MAX_FILE_BYTES:
                parts.append(
                    f"\n# Skipped {path}: file too large "
                    f"({size // 1024} KB > {_MAX_FILE_BYTES // 1024} KB limit)"
                )
                continue
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError as exc:
            parts.append(f"\n# Could not read {path}: {exc}")
            continue
        ext = os.path.splitext(path)[1].lstrip(".")
        parts.append(f"\n\n```{ext}\n# {path}\n{content}\n```")
    return "\n".join(parts)
