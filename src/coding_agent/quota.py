"""Quota management for coding-agent-mcp.

Two-layer approach:
  1. Reactive  — quota state is updated from every dispatch response
                 (rate-limit headers on 429s, or usage headers on success).
  2. Proactive — each dispatcher can optionally implement check_quota() for
                 a live snapshot. Results are cached with a TTL to avoid
                 hammering provider APIs.

The router calls get_quota_score(service) before dispatching and
record_result(service, result) after. Circuit-breaker state lives in
the Router; this class only tracks quota availability scores.
"""

import asyncio
import json
import os
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .dispatchers.base import BaseDispatcher, DispatchResult, QuotaInfo

_DEFAULT_TTL = 300  # seconds between proactive quota checks

class QuotaState:
    """Mutable quota snapshot for one service, updated reactively."""

    def __init__(self, service: str):
        self.service = service
        self.remaining: int | None = None
        self.limit: int | None = None
        self.used: int | None = None
        self.reset_at: str | None = None
        self.source: str = "unknown"
        self._updated_at: float = 0.0

    @property
    def score(self) -> float:
        """0.0–1.0 availability score. 1.0 = assume available."""
        if self.remaining is not None and self.limit and self.limit > 0:
            return max(0.0, min(1.0, self.remaining / self.limit))
        if self.used is not None and self.limit and self.limit > 0:
            return max(0.0, min(1.0, (self.limit - self.used) / self.limit))
        return 1.0

    def update_from_quota_info(self, info: "QuotaInfo") -> None:
        self.remaining = info.remaining
        self.limit = info.limit
        self.used = info.used
        self.reset_at = info.reset_at
        self.source = info.source
        self._updated_at = time.monotonic()

    def to_dict(self) -> dict:
        return {
            "used": self.used,
            "limit": self.limit,
            "remaining": self.remaining,
            "reset_at": self.reset_at,
            "score": self.score,
            "source": self.source,
            "updated_age_seconds": round(time.monotonic() - self._updated_at, 1),
        }

class QuotaCache:
    """
    Manages quota state for all dispatchers.

    Usage:
      score = await cache.get_quota_score("gemini")
      cache.record_result("gemini", dispatch_result)
      status = await cache.full_status()
    """

    def __init__(
        self,
        dispatchers: dict[str, "BaseDispatcher"],
        ttl: int = _DEFAULT_TTL,
        state_file: str = "quota_state.json",
    ):
        self._dispatchers = dispatchers
        self._ttl = ttl
        self._state_file = state_file
        # Per-service reactive quota state
        self._states: dict[str, QuotaState] = {
            name: QuotaState(name) for name in dispatchers
        }
        # Timestamp of last proactive check per service
        self._last_checked: dict[str, float] = {}
        # Local call counter (persisted, used for rough scoring when quota unknown)
        self._local_counts: dict[str, int] = self._load_local_counts()

    # ------------------------------------------------------------------
    # Public API — called by Router
    # ------------------------------------------------------------------

    async def get_quota_score(self, service: str) -> float:
        """
        Return 0.0–1.0 availability score for a service.

        Triggers a proactive check if data is stale and the dispatcher
        supports it (check_quota() returns non-unknown). Otherwise relies
        on the reactive state updated by record_result().
        """
        await self._maybe_refresh(service)
        state = self._states.get(service)
        return state.score if state else 1.0

    def record_result(self, service: str, result: "DispatchResult") -> None:
        """Update quota state from a completed dispatch result."""
        self._local_counts[service] = self._local_counts.get(service, 0) + 1
        # Write to disk on a thread-pool thread so we don't block the event loop.
        # Fire-and-forget: if this fails silently the count is still correct in memory.
        try:
            loop = asyncio.get_running_loop()
            loop.run_in_executor(None, self._save_local_counts)
        except RuntimeError:
            # No running loop (e.g. called from tests) — write synchronously.
            self._save_local_counts()

        if not result.rate_limit_headers and not result.rate_limited:
            # Successful call with no rate-limit data — nothing to update
            return

        state = self._states.setdefault(service, QuotaState(service))

        if result.rate_limit_headers:
            from .dispatchers.utils import parse_remaining, parse_limit
            remaining = parse_remaining(result.rate_limit_headers)
            limit = parse_limit(result.rate_limit_headers)
            if remaining is not None or limit is not None:
                state.remaining = remaining
                state.limit = limit
                state.source = "headers"
                state._updated_at = time.monotonic()

    async def get_quota_info(self, service: str) -> "QuotaInfo | None":
        """Return the latest QuotaInfo for a service (triggers refresh if stale)."""
        await self._maybe_refresh(service)
        state = self._states.get(service)
        if state is None:
            return None
        from .dispatchers.base import QuotaInfo
        return QuotaInfo(
            service=service,
            used=state.used,
            limit=state.limit,
            remaining=state.remaining,
            reset_at=state.reset_at,
            source=state.source,
        )

    async def full_status(self) -> dict[str, dict]:
        """Return quota status for all dispatchers."""
        result = {}
        for service in self._dispatchers:
            await self._maybe_refresh(service)
            state = self._states.get(service, QuotaState(service))
            d = state.to_dict()
            d["local_call_count"] = self._local_counts.get(service, 0)
            result[service] = d
        return result

    # ------------------------------------------------------------------
    # Proactive refresh
    # ------------------------------------------------------------------

    async def _maybe_refresh(self, service: str) -> None:
        """Trigger proactive check_quota() if TTL has expired."""
        last = self._last_checked.get(service, 0.0)
        if time.monotonic() - last < self._ttl:
            return

        dispatcher = self._dispatchers.get(service)
        if dispatcher is None:
            return

        self._last_checked[service] = time.monotonic()
        try:
            info = await asyncio.wait_for(dispatcher.check_quota(), timeout=15)
            if info.source != "unknown":
                state = self._states.setdefault(service, QuotaState(service))
                state.update_from_quota_info(info)
        except Exception:
            pass  # Proactive check failed — rely on reactive state

    # ------------------------------------------------------------------
    # Local count persistence
    # ------------------------------------------------------------------

    def _load_local_counts(self) -> dict[str, int]:
        if os.path.exists(self._state_file):
            try:
                with open(self._state_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return {k: v.get("local_calls", 0) for k, v in data.items()}
            except (json.JSONDecodeError, OSError, AttributeError):
                pass
        return {}

    def _save_local_counts(self) -> None:
        existing: dict[str, dict] = {}
        if os.path.exists(self._state_file):
            try:
                with open(self._state_file, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        for service, count in self._local_counts.items():
            existing.setdefault(service, {})["local_calls"] = count
        try:
            with open(self._state_file, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
        except OSError:
            pass
