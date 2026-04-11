"""OpenAI Codex CLI dispatcher for coding-agent-mcp.

Dispatch:  codex exec "<prompt>" --full-auto --ephemeral --json [--cd <dir>]
           Uses codex exec (non-interactive mode). --full-auto bypasses approval
           prompts; --ephemeral skips persisting session rollout files to disk.
           --json gives newline-delimited JSON events for structured parsing.

Quota:     Reactive only. Codex uses token-based pricing (no hard monthly limit).
           Rate limits are per-minute/hour and reset quickly. Circuit breaker
           handles exhaustion reactively from 429 responses.

Note:      codex mcp-server also exists (runs Codex as MCP over stdio) but
           requires us to act as an MCP client — deferred for now, exec is simpler.
"""

import asyncio
import json
import re
import shutil
import time

from .base import BaseDispatcher, DispatchResult, UNKNOWN_QUOTA
from .utils import run_subprocess, build_prompt_with_files

class CodexDispatcher(BaseDispatcher):
    """Dispatches coding tasks to the OpenAI Codex CLI via codex exec."""

    def __init__(
        self,
        command: str = "codex",
        timeout: int = 120,
        api_key: str | None = None,
        model: str | None = None,
    ):
        self.command = command
        self.timeout = timeout
        self.api_key = api_key  # injected as OPENAI_API_KEY env var if set
        self.model = model      # e.g. "o4", "o4-mini", "gpt-4o"

    def is_available(self) -> bool:
        return shutil.which(self.command) is not None

    async def check_quota(self):
        """Token-based pricing — no hard quota to proactively check."""
        return UNKNOWN_QUOTA("codex")

    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> DispatchResult:
        if not self.is_available():
            return DispatchResult(
                output="", service="codex", success=False,
                error=f"'{self.command}' not found in PATH",
            )

        full_prompt = build_prompt_with_files(prompt, files)

        # codex exec: non-interactive, bypass approvals, JSON Lines output.
        # --skip-git-repo-check allows running outside a git repo.
        # --ephemeral was removed in newer Codex CLI versions.
        cmd = [self.command, "exec", full_prompt,
               "--full-auto", "--json", "--skip-git-repo-check"]
        if self.model:
            cmd += ["--model", self.model]
        if working_dir:
            cmd += ["--cd", working_dir]

        try:
            rc, stdout, stderr = await run_subprocess(
                *cmd, timeout=self.timeout, cwd=working_dir or None,
                extra_env={"OPENAI_API_KEY": self.api_key} if self.api_key else None,
            )
        except asyncio.TimeoutError:
            return DispatchResult(
                output="", service="codex", success=False,
                error=f"Timed out after {self.timeout}s",
            )
        except Exception as exc:
            return DispatchResult(output="", service="codex", success=False, error=str(exc))

        # Always try to extract structured output first — Codex can emit complete
        # JSONL events to stdout and still exit non-zero (e.g. sandboxing errors
        # after the agent finishes). Parsing must happen before the rc check.
        # On Windows via cmd /c, output may land on stderr instead of stdout.
        output = _extract_output(stdout) or _extract_output(stderr)

        if output:
            return DispatchResult(output=output, service="codex", success=True)

        # No parseable agent output — fall through to error handling.
        rate_limited, retry_after = _detect_rate_limit(stdout + stderr)
        error_detail = stderr.strip() or stdout.strip() or f"Exit code {rc}"
        return DispatchResult(
            output=error_detail, service="codex", success=False,
            error=error_detail,
            rate_limited=rate_limited,
            retry_after=retry_after,
        )

# ---------------------------------------------------------------------------
# JSON Lines event parser
# ---------------------------------------------------------------------------

def _extract_output(jsonl: str) -> str:
    """
    Extract the last agent_message text from codex exec --json output.

    Confirmed format (codex-rs/exec/src/exec_events.rs, ThreadEvent enum):
        {"type": "item.completed", "item": {"id": "...", "type": "agent_message", "text": "..."}}

    Returns the last agent_message text found, or "" if nothing matches.
    Returns "" (not raw JSONL) so callers can cleanly check for failure.
    """
    last_text = ""
    for line in jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "item.completed":
            continue
        item = event.get("item", {})
        if not isinstance(item, dict) or item.get("type") != "agent_message":
            continue
        text = item.get("text", "")
        if text:
            last_text = text
    return last_text.strip()

# ---------------------------------------------------------------------------
# Rate limit detection
# ---------------------------------------------------------------------------

def _detect_rate_limit(text: str) -> tuple[bool, float | None]:
    """
    Detect rate limiting from Codex CLI error output or JSON event stream.

    Codex 429 headers (from codex-rs/codex-api/src/rate_limits.rs):
      x-codex-active-limit: <limit-id>
      x-{limit-id}-primary-reset-at: <epoch seconds>
    """
    lowered = text.lower()
    is_rate_limited = (
        "usage_limit_reached" in lowered
        or "usage_not_included" in lowered
        or "rate limit" in lowered
        or "429" in text
        or "too many requests" in lowered
    )
    if not is_rate_limited:
        for line in text.splitlines():
            try:
                event = json.loads(line)
                if event.get("type") == "error":
                    err_text = str(event).lower()
                    if "rate" in err_text or "limit" in err_text or "429" in err_text:
                        is_rate_limited = True
                        break
            except json.JSONDecodeError:
                continue

    if not is_rate_limited:
        return False, None

    retry_after: float | None = None
    m = re.search(r"primary-reset-at[:\s]+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if m:
        try:
            retry_after = max(0.0, float(m.group(1)) - time.time())
        except ValueError:
            pass
    if retry_after is None:
        m2 = re.search(r"retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
        if m2:
            try:
                retry_after = float(m2.group(1))
            except ValueError:
                pass

    return True, retry_after
