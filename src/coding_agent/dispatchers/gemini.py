"""Gemini CLI dispatcher for coding-agent-mcp.

Dispatch: gemini -p "<prompt>" [--file <path> ...] --output-format json
Quota:    parse the stats field from the JSON response (proactive),
          or update from rate-limit headers after a 429 (reactive).
"""

import asyncio
import json
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from .base import BaseDispatcher, DispatchResult, QuotaInfo, UNKNOWN_QUOTA
from .utils import run_subprocess

# Gemini CLI settings file — thinking level is configured here (no CLI flag exists yet).
_GEMINI_SETTINGS = Path.home() / ".gemini" / "settings.json"
_THINKING_MAP = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}

# Module-level lock: prevents concurrent dispatches from racing on settings.json.
_settings_lock = asyncio.Lock()

@asynccontextmanager
async def _gemini_thinking_override(thinking_level: str | None):
    """
    Temporarily inject thinkingLevel into ~/.gemini/settings.json for one dispatch.

    Gemini CLI reads settings.json on startup; there is no per-invocation CLI flag
    (feature request: github.com/google-gemini/gemini-cli/issues/21974).
    We patch the file, yield, then restore the original. The module-level asyncio.Lock
    prevents concurrent dispatches (e.g. from code_mixture) from stomping each other.
    """
    if not thinking_level:
        yield
        return

    level = _THINKING_MAP.get(thinking_level.lower())
    if not level:
        yield
        return

    async with _settings_lock:
        settings_path = _GEMINI_SETTINGS
        settings_path.parent.mkdir(parents=True, exist_ok=True)

        # Read existing settings (may not exist yet)
        original_text: str | None = None
        if settings_path.exists():
            original_text = settings_path.read_text(encoding="utf-8")
            try:
                settings = json.loads(original_text)
            except json.JSONDecodeError:
                settings = {}
        else:
            settings = {}

        # Inject thinking level
        settings.setdefault("modelConfigs", {})
        settings["modelConfigs"].setdefault("generateContentConfig", {})
        settings["modelConfigs"]["generateContentConfig"]["thinkingLevel"] = level

        settings_path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
        try:
            yield
        finally:
            # Restore original
            if original_text is not None:
                settings_path.write_text(original_text, encoding="utf-8")
            else:
                # We created the file — remove just our addition
                try:
                    restored = json.loads(settings_path.read_text(encoding="utf-8"))
                    restored.get("modelConfigs", {}).get(
                        "generateContentConfig", {}
                    ).pop("thinkingLevel", None)
                    settings_path.write_text(json.dumps(restored, indent=2), encoding="utf-8")
                except Exception:
                    pass

class GeminiDispatcher(BaseDispatcher):
    """Dispatches coding tasks to the Gemini CLI (headless JSON mode)."""

    def __init__(
        self,
        command: str = "gemini",
        timeout: int = 120,
        api_key: str | None = None,
        model: str | None = None,
        thinking_level: str | None = None,
    ):
        self.command = command
        self.timeout = timeout
        self.api_key = api_key          # injected as GEMINI_API_KEY env var if set
        self.model = model              # e.g. "gemini-3.1-pro-preview", "gemini-2.5-flash"
        self.thinking_level = thinking_level  # "low" | "medium" | "high" | None

    def is_available(self) -> bool:
        return shutil.which(self.command) is not None

    def _model_args(self) -> list[str]:
        """Return ['--model', '<name>'] when a model is configured, else []."""
        return ["--model", self.model] if self.model else []

    async def check_quota(self) -> QuotaInfo:
        """
        Run `gemini -p "." --output-format json` with a minimal no-op prompt
        to get the stats field without doing real work.
        """
        if not self.is_available():
            return UNKNOWN_QUOTA("gemini")

        try:
            rc, stdout, _ = await run_subprocess(
                self.command, *self._model_args(), "-p", ".", "--output-format", "json",
                timeout=15,
                extra_env={"GEMINI_API_KEY": self.api_key} if self.api_key else None,
            )
        except asyncio.TimeoutError:
            return UNKNOWN_QUOTA("gemini")
        except Exception:
            return UNKNOWN_QUOTA("gemini")

        return _parse_gemini_json_quota(stdout)

    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> DispatchResult:
        if not self.is_available():
            return DispatchResult(
                output="", service="gemini", success=False,
                error=f"'{self.command}' not found in PATH",
            )

        cmd = [self.command, *self._model_args(), "-p", prompt, "--output-format", "json"]
        for path in files:
            cmd += ["--file", path]

        try:
            async with _gemini_thinking_override(self.thinking_level):
                rc, stdout, stderr = await run_subprocess(
                    *cmd, timeout=self.timeout, cwd=working_dir or None,
                    extra_env={"GEMINI_API_KEY": self.api_key} if self.api_key else None,
                )
        except asyncio.TimeoutError:
            return DispatchResult(
                output="", service="gemini", success=False,
                error=f"Timed out after {self.timeout}s",
            )
        except Exception as exc:
            return DispatchResult(output="", service="gemini", success=False, error=str(exc))

        # Detect rate limiting
        if rc != 0:
            rate_limited, retry_after = _detect_rate_limit(stdout + stderr)
            return DispatchResult(
                output=stdout.strip(), service="gemini", success=False,
                error=stderr.strip() or f"Exit code {rc}",
                rate_limited=rate_limited,
                retry_after=retry_after,
            )

        # Parse JSON response to extract the actual text output
        output = _extract_response_text(stdout)
        return DispatchResult(output=output, service="gemini", success=True)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_gemini_json_quota(raw: str) -> QuotaInfo:
    """
    Parse quota/stats from `gemini --output-format json` output.

    Expected shape (as per Gemini CLI docs):
    {
      "response": "...",
      "stats": {
        "requests_this_minute": 3,
        "requests_per_minute_limit": 60,
        "requests_today": 147,
        "requests_per_day_limit": 1000,
        "tokens_this_minute": 1234,
        "tokens_per_minute_limit": 100000
      }
    }
    """
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return UNKNOWN_QUOTA("gemini")

    stats = data.get("stats")
    if not stats:
        return UNKNOWN_QUOTA("gemini")

    # Prefer per-day quota as the coarser / more meaningful limit
    used = stats.get("requests_today") or stats.get("requests_this_minute")
    limit = stats.get("requests_per_day_limit") or stats.get("requests_per_minute_limit")
    remaining = None
    if used is not None and limit is not None:
        remaining = max(0, limit - used)

    return QuotaInfo(
        service="gemini",
        used=used,
        limit=limit,
        remaining=remaining,
        reset_at=None,
        source="json",
    )

def _extract_response_text(raw: str) -> str:
    """Extract the 'response' field from Gemini JSON output, falling back to raw text."""
    try:
        data = json.loads(raw)
        return data.get("response", raw).strip()
    except (json.JSONDecodeError, ValueError):
        return raw.strip()

def _detect_rate_limit(text: str) -> tuple[bool, float | None]:
    """Return (rate_limited, retry_after_seconds) from error text."""
    lowered = text.lower()
    is_rate_limited = (
        "rate limit" in lowered
        or "quota exceeded" in lowered
        or "429" in text
        or "resource_exhausted" in lowered
        or "too many requests" in lowered
    )
    if not is_rate_limited:
        return False, None

    # Try to extract a retry delay (seconds)
    m = re.search(r"retry[_\s]after[:\s]+(\d+(?:\.\d+)?)", text, re.IGNORECASE)
    retry_after = float(m.group(1)) if m else None
    return True, retry_after
