"""Cursor dispatcher for coding-agent-mcp.

Dispatch:  agent -p --output-format json "<prompt>" [--cd <dir>]
           Uses the Cursor headless CLI (installed via cursor.com/install).
           The command name is 'agent', not 'cursor'.
           Requires CURSOR_API_KEY in the environment for authentication.

Quota:     No proactive quota API available via CLI. Reactive only —
           circuit breaker handles failures.
"""

import asyncio
import json
import os
import re
import shutil

from .base import BaseDispatcher, DispatchResult, UNKNOWN_QUOTA
from .utils import run_subprocess

class CursorDispatcher(BaseDispatcher):
    """Dispatches coding tasks to the Cursor headless CLI (agent)."""

    def __init__(
        self,
        command: str = "agent",
        timeout: int = 120,
        api_key: str | None = None,
        model: str | None = None,
        thinking_level: str | None = None,
    ):
        self.command = command
        self.timeout = timeout
        self.api_key = api_key      # injected as CURSOR_API_KEY
        self.model = model          # passed via --model if set
        self.thinking_level = thinking_level  # not yet supported by CLI

    def is_available(self) -> bool:
        return shutil.which(self.command) is not None

    async def check_quota(self):
        """No proactive quota check available via the Cursor CLI."""
        return UNKNOWN_QUOTA("cursor")

    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> DispatchResult:
        if not self.is_available():
            return DispatchResult(
                output="", service="cursor", success=False,
                error=f"'{self.command}' not found in PATH — install via cursor.com/install",
            )

        full_prompt = prompt
        if files:
            file_list = "\n".join(f"  - {p}" for p in files)
            full_prompt = f"{prompt}\n\nFocus on these files:\n{file_list}"

        # agent -p: print mode (non-interactive).
        # --trust: skip workspace trust prompt (headless mode only).
        # --workspace: set the working directory for the agent.
        # --output-format json: emits a single JSON object with a "result" field.
        effective_dir = working_dir or os.path.expanduser("~")
        cmd = [
            self.command, "-p",
            "--trust",
            "--workspace", effective_dir,
            "--output-format", "json",
            full_prompt,
        ]
        if self.model:
            cmd += ["--model", self.model]

        extra_env = {}
        if self.api_key:
            extra_env["CURSOR_API_KEY"] = self.api_key

        try:
            rc, stdout, stderr = await run_subprocess(
                *cmd, timeout=self.timeout, cwd=effective_dir,
                extra_env=extra_env or None,
            )
        except asyncio.TimeoutError:
            return DispatchResult(
                output="", service="cursor", success=False,
                error=f"Timed out after {self.timeout}s",
            )
        except Exception as exc:
            return DispatchResult(output="", service="cursor", success=False, error=str(exc))

        if rc == 0:
            output = _extract_output(stdout) or _extract_output(stderr)
            if output:
                return DispatchResult(output=output, service="cursor", success=True)

        rate_limited, retry_after = _detect_rate_limit(stdout + stderr)
        error_detail = stderr.strip() or stdout.strip() or f"Exit code {rc}"
        return DispatchResult(
            output=error_detail, service="cursor", success=False,
            error=error_detail,
            rate_limited=rate_limited,
            retry_after=retry_after,
        )

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _detect_rate_limit(text: str) -> tuple[bool, float | None]:
    """Return (rate_limited, retry_after_seconds) from error text."""
    lowered = text.lower()
    is_rate_limited = (
        "rate limit" in lowered
        or "too many requests" in lowered
        or "429" in text
        or "quota exceeded" in lowered
        or "ratelimiterror" in lowered
    )
    if not is_rate_limited:
        return False, None
    m = re.search(r"retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    retry_after = float(m.group(1)) if m else None
    return True, retry_after

# ---------------------------------------------------------------------------
# JSON output parser
# ---------------------------------------------------------------------------

def _extract_output(text: str) -> str:
    """
    Extract the result text from `agent --output-format json` output.

    The CLI emits a single JSON object with a top-level "result" field:
        {"result": "...", "duration_ms": 1234, ...}
    """
    if not text.strip():
        return ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        result = obj.get("result")
        if isinstance(result, str) and result:
            return result.strip()
    return ""
