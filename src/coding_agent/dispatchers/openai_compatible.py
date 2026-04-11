"""OpenAI-compatible HTTP dispatcher for coding-agent-mcp.

Handles any provider that speaks POST /v1/chat/completions:
  - Ollama        (http://localhost:11434/v1)
  - LM Studio     (http://localhost:1234/v1)
  - AnythingLLM   (http://localhost:3001/v1)
  - OpenRouter    (https://openrouter.ai/api/v1)
  - OpenAI API    (https://api.openai.com/v1)
  - Any other OpenAI-compatible endpoint

Dispatch:  POST {base_url}/v1/chat/completions (blocking)
Quota:     Reactive — parses x-ratelimit-* headers from every response.
           Local endpoints (Ollama, LM Studio) have no rate limits.
"""

import asyncio
import json
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .base import BaseDispatcher, DispatchResult, QuotaInfo, UNKNOWN_QUOTA
from .utils import build_prompt_with_files, parse_retry_after

_CHAT_PATH = "/v1/chat/completions"
_DEFAULT_SYSTEM_PROMPT = (
    "You are an expert software engineer. "
    "Respond with clear, working code and concise explanations."
)

class OpenAICompatibleDispatcher(BaseDispatcher):
    """
    Dispatches coding tasks to any OpenAI-compatible /v1/chat/completions endpoint.

    Args:
        name:     Service name (used in DispatchResult and tool names)
        base_url: Base URL, e.g. http://localhost:11434/v1
        model:    Model name, e.g. llama3.2
        api_key:  Bearer token. Pass empty string for local endpoints (Ollama etc.)
        timeout:  Request timeout in seconds
    """

    def __init__(
        self,
        name: str,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout: int = 120,
        thinking_level: str | None = None,
    ):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key or ""
        self.timeout = timeout
        # reasoning_effort is the OpenAI field; "low"/"medium"/"high"
        self.thinking_level = thinking_level

    def is_available(self) -> bool:
        """Check if the endpoint is reachable with a quick HEAD/GET."""
        # For local endpoints, try to connect; for remote, assume available.
        if "localhost" in self.base_url or "127.0.0.1" in self.base_url:
            parsed = urlparse(self.base_url)
            host = parsed.hostname or "127.0.0.1"
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            try:
                with socket.create_connection((host, port), timeout=2):
                    return True
            except OSError:
                return False
        return True  # Remote endpoints assumed available until a call fails

    async def check_quota(self) -> QuotaInfo:
        """Local endpoints have no quota. Remote endpoints tracked reactively."""
        return UNKNOWN_QUOTA(self.name)

    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> DispatchResult:
        full_prompt = build_prompt_with_files(prompt, files)
        url = f"{self.base_url}{_CHAT_PATH}"

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _DEFAULT_SYSTEM_PROMPT},
                {"role": "user", "content": full_prompt},
            ],
            "stream": False,
        }
        # reasoning_effort is supported by OpenAI reasoning models (o-series, gpt-5.x).
        # Local endpoints (Ollama, LM Studio) silently ignore unknown fields.
        if self.thinking_level:
            payload["reasoning_effort"] = self.thinking_level.lower()

        loop = asyncio.get_running_loop()
        try:
            status, body, headers = await loop.run_in_executor(
                None, _post_chat, url, payload, self.api_key, self.timeout
            )
        except Exception as exc:
            return DispatchResult(
                output="", service=self.name, success=False,
                error=str(exc),
            )

        if status == 429:
            return DispatchResult(
                output="", service=self.name, success=False,
                error=f"Rate limited by {self.name}",
                rate_limited=True,
                retry_after=parse_retry_after(headers),
                rate_limit_headers=headers,
            )

        if status >= 400:
            err = body.get("error", {})
            msg = err.get("message", "") if isinstance(err, dict) else str(err)
            return DispatchResult(
                output="", service=self.name, success=False,
                error=f"HTTP {status}: {msg or json.dumps(body)[:200]}",
            )

        # Extract response text from choices[0].message.content
        output = _extract_content(body)
        if output is None:
            return DispatchResult(
                output="", service=self.name, success=False,
                error=f"Unexpected response shape: {json.dumps(body)[:300]}",
            )

        return DispatchResult(
            output=output,
            service=self.name,
            success=True,
            rate_limit_headers=headers,  # carries x-ratelimit-* for quota tracking
        )

# ---------------------------------------------------------------------------
# HTTP helpers (synchronous — run in executor)
# ---------------------------------------------------------------------------

def _post_chat(
    url: str,
    payload: dict,
    api_key: str,
    timeout: int,
) -> tuple[int, dict, dict]:
    """POST to /v1/chat/completions. Returns (status, body_dict, headers_dict)."""
    data = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = Request(url, data=data, headers=headers, method="POST")
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
            return resp.status, body, dict(resp.headers)
    except HTTPError as exc:
        resp_headers = dict(exc.headers) if exc.headers else {}
        try:
            body = json.loads(exc.read().decode("utf-8", errors="replace"))
        except Exception:
            body = {"error": {"message": str(exc)}}
        return exc.code, body, resp_headers
    except URLError as exc:
        raise ConnectionError(
            f"Cannot reach {url}: {exc.reason}. "
            "Is the local model server running?"
        ) from exc

def _extract_content(body: dict) -> str | None:
    """Extract text from OpenAI chat completions response."""
    choices = body.get("choices")
    if not choices or not isinstance(choices, list):
        return None
    first = choices[0]
    if isinstance(first, dict):
        message = first.get("message", {})
        if isinstance(message, dict):
            return message.get("content", "")
    return None
