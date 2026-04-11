"""Base dispatcher interface for coding-agent-mcp."""

import abc
from dataclasses import dataclass, field

@dataclass
class DispatchResult:
    output: str
    service: str
    success: bool
    error: str | None = None
    # Populated when the provider signals a rate limit (HTTP 429 or equivalent).
    # The router uses these to set a precise circuit-breaker cooldown.
    rate_limited: bool = False
    retry_after: float | None = None   # seconds until quota resets
    # Raw rate limit headers from the response (for quota state updates)
    rate_limit_headers: dict[str, str] = field(default_factory=dict)

@dataclass
class QuotaInfo:
    """Quota snapshot — either from a proactive check or a reactive header parse."""
    service: str
    used: int | None        # calls/tokens used in current window
    limit: int | None       # total allowed in window
    remaining: int | None   # remaining in window
    reset_at: str | None    # ISO timestamp or epoch of next reset
    source: str = "unknown"    # "json" | "file" | "headers" | "api" | "unknown"

    @property
    def score(self) -> float:
        """0.0–1.0 availability score. 1.0 = full quota available."""
        if self.remaining is not None and self.limit and self.limit > 0:
            return max(0.0, min(1.0, self.remaining / self.limit))
        if self.used is not None and self.limit and self.limit > 0:
            return max(0.0, min(1.0, (self.limit - self.used) / self.limit))
        return 1.0  # unknown → assume available

def UNKNOWN_QUOTA(service: str) -> QuotaInfo:
    """Return a QuotaInfo indicating no quota data is available for this service."""
    return QuotaInfo(
        service=service,
        used=None, limit=None, remaining=None, reset_at=None,
        source="unknown",
    )

class BaseDispatcher(abc.ABC):
    """Abstract base for all CLI/API dispatchers."""

    @abc.abstractmethod
    async def dispatch(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> DispatchResult:
        """Run the coding task and return a DispatchResult."""
        ...

    async def check_quota(self) -> QuotaInfo:
        """Proactively query the provider for live quota info.

        Override in each dispatcher. The default returns an 'unknown' quota,
        which the router treats as fully available.
        """
        return UNKNOWN_QUOTA(self.__class__.__name__.replace("Dispatcher", "").lower())
