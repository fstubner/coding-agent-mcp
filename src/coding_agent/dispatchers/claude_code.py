"""Claude Code CLI dispatcher for coding-agent-mcp.

Dispatch:  claude -p "<prompt>" --output-format json
                 --allowedTools "Bash,Read,Edit,Write"
                 --permission-mode acceptEdits

  -p / --print             Non-interactive mode (prints response and exits).
  --output-format json     Structured output with a top-level 'result' field.
  --allowedTools           Pre-approve tools so no interactive prompts block.
  --permission-mode acceptEdits  Allow file writes without per-edit confirmation.
  --settings '{"autoMemory":false}'  Skip workspace history scan on cold start.

  Auth: --bare is intentionally NOT used. --bare bypasses OAuth/keychain and
  requires ANTHROPIC_API_KEY. We use subscription auth (Claude Desktop OAuth),
  so omitting --bare lets the CLI pick up the saved credentials normally.
  Without --bare, Claude Code will also load the project's MCP config, which
  is fine — this dispatcher runs as a sub-agent, not the orchestrator.

Quota:     Reactive only — rate-limit info is parsed from process output.
           Claude quota is shared across Claude Desktop and the API (same acct).
           No proactive quota endpoint; state updated from each dispatch result.
"""

import asyncio
import json
import os
import re
import shutil

from .base import BaseDispatcher, DispatchResult, UNKNOWN_QUOTA
from .utils import run_subprocess

_ALLOWED_TOOLS = "Bash,Read,Edit,Write"

class ClaudeCodeDispatcher(BaseDispatcher):
    """Dispatches coding tasks to the Claude Code CLI."""

    def __init__(
        self,
        command: str = "claude",
        timeout: int = 120,
        api_key: str | None = None,
        model: str | None = None,
    ):
        self.command = command
        self.timeout = timeout
        self.api_key = api_key  # injected as ANTHROPIC_API_KEY env var if set
        self.model = model      # e.g. "claude-opus-4-6", "claude-sonnet-4-5"

    def is_available(self) -> bool:
        return shutil.which(self.command) is not None

    async def check_quota(self):
        """No proactive quota endpoint — rely on reactive circuit breaker."""
        return UNKNOWN_QUOTA("claude_code")

    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
        model_override: str | None = None,
    ) -> DispatchResult:
        if not self.is_available():
            return DispatchResult(
                output="", service="claude_code", success=False,
                error=f"'{self.command}' not found in PATH",
            )

        # Pass file paths in the prompt body — the Read tool handles loading them.
        full_prompt = prompt
        if files:
            file_list = "\n".join(f"  {p}" for p in files)
            full_prompt = f"{prompt}\n\nFiles to work with:\n{file_list}"

        # model_override (from escalate_model routing) takes priority over
        # the instance default, allowing Sonnet→Opus escalation at dispatch time.
        effective_model = model_override or self.model

        cmd = [
            self.command,
            "-p", full_prompt,
            "--output-format", "json",
            "--allowedTools", _ALLOWED_TOOLS,
            "--permission-mode", "acceptEdits",
            # Disable auto-memory to speed up cold start (avoids reading
            # the entire workspace history before responding).
            "--settings", '{"autoMemory":false}',
        ]
        if effective_model:
            cmd += ["--model", effective_model]

        # If an explicit API key is configured, inject it.
        # Otherwise (subscription/OAuth mode) strip any empty ANTHROPIC_API_KEY
        # from the environment so the CLI falls back to its stored OAuth token.
        if self.api_key:
            subprocess_env = {"ANTHROPIC_API_KEY": self.api_key}
        else:
            subprocess_env = {k: v for k, v in os.environ.items()
                              if not (k == "ANTHROPIC_API_KEY" and not v)}

        try:
            rc, stdout, stderr = await run_subprocess(
                *cmd, timeout=self.timeout, cwd=working_dir or None,
                extra_env=subprocess_env,
            )
        except asyncio.TimeoutError:
            return DispatchResult(
                output="", service="claude_code", success=False,
                error=f"Timed out after {self.timeout}s",
            )
        except Exception as exc:
            return DispatchResult(
                output="", service="claude_code", success=False, error=str(exc)
            )

        if rc != 0:
            rate_limited, retry_after = _detect_rate_limit(stdout + stderr)
            return DispatchResult(
                output=stdout.strip(), service="claude_code", success=False,
                error=stderr.strip() or f"Exit code {rc}",
                rate_limited=rate_limited,
                retry_after=retry_after,
            )

        output = _extract_result(stdout)
        return DispatchResult(output=output, service="claude_code", success=True)

# ---------------------------------------------------------------------------
# Output parser
# ---------------------------------------------------------------------------

def _extract_result(raw: str) -> str:
    """
    Parse claude -p --output-format json output.

    Response shape:
    {
      "result": "the assistant's response text",
      "session_id": "...",
      "is_error": false,
      "cost_usd": 0.001,
      "usage": {"input_tokens": 123, "output_tokens": 45}
    }
    """
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            result = data.get("result") or data.get("response") or data.get("text")
            if result:
                return str(result).strip()
    except (json.JSONDecodeError, ValueError):
        pass
    return raw.strip()

# ---------------------------------------------------------------------------
# Rate limit detection
# ---------------------------------------------------------------------------

def _detect_rate_limit(text: str) -> tuple[bool, float | None]:
    """
    Detect rate limiting from Claude Code output.

    Claude Code emits system/api_retry events with error field:
      "rate_limit" | "server_error" | "billing_error" | etc.

    Also detects plain-text rate limit messages.
    """
    lowered = text.lower()
    is_rate_limited = (
        "rate_limit" in lowered
        or "rate limit" in lowered
        or "too many requests" in lowered
        or "ratelimiterror" in lowered
        or "429" in text
        or "overloaded" in lowered
    )

    # Also check stream-json events (if --output-format stream-json were used)
    if not is_rate_limited:
        for line in text.splitlines():
            try:
                event = json.loads(line)
                if (event.get("type") == "system"
                        and event.get("subtype") == "api_retry"
                        and event.get("error") == "rate_limit"):
                    is_rate_limited = True
                    delay_ms = event.get("retry_delay_ms")
                    if delay_ms:
                        return True, float(delay_ms) / 1000.0
            except json.JSONDecodeError:
                continue

    if not is_rate_limited:
        return False, None

    retry_after: float | None = None
    m = re.search(r"retry[_\s-]after[:\s]+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if m:
        try:
            retry_after = float(m.group(1))
        except ValueError:
            pass

    return True, retry_after
