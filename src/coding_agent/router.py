"""Load-balancing router for coding-agent-mcp.

Routing strategy
----------------
Services are grouped by tier (lower number = higher quality). The router
always exhausts the current tier before falling to the next:

  Tier 1 (frontier)  →  Tier 2 (strong)  →  Tier 3 (fast/local)

A tier is considered exhausted when every service in it is circuit-broken
(rate-limited or repeatedly failing).

Quality scoring
---------------
Within a tier, services are ranked by a composite score:

  final_score = quality_score × cli_capability × capability[task_type]
                × quota_score × weight

Where:
  quality_score = normalized_elo × thinking_multiplier
    normalized_elo   — Arena ELO mapped to [0.60, 1.00] (from LeaderboardCache)
    thinking_mult    — 1.00 (none/low) / 1.07 (medium) / 1.15 (high)

  cli_capability     — CLI agent amplification factor (from config, default 1.0)
                       Captures how much the agentic scaffold adds beyond raw ELO

  capability[task_type] — per-task-type relative strength from config:
                          "execute": autonomous multi-step coding (SWE-bench style)
                          "plan":    architecture, design, reasoning-heavy decisions
                          "review":  code review, explanation, refactor suggestions
                          1.0 = best in class; omit key to default to 1.0

  quota_score    — current quota availability from QuotaCache [0.0, 1.0]
  weight         — static multiplier from config (default 1.0)

Tier auto-derivation
--------------------
If a service has ``leaderboard_model`` set in config, its tier is
auto-derived from the Arena ELO score using these thresholds:
  ELO ≥ 1350  → Tier 1
  ELO ≥ 1200  → Tier 2
  ELO < 1200  → Tier 3

Explicit ``tier`` in config is used as a fallback when ELO is unavailable.

Routing hints (accepted via code_auto and code_mixture)
-------------------------------------------------------
  service (str)               — force a specific provider, skip tier logic
  prefer_large_context (bool) — +0.3 score bonus for Gemini (1M token window)
  task_type (str)             — "execute" | "plan" | "review" | "local"
                                Drives capability-profile weighting.
                                "local" also boosts openai_compatible localhost services.
"""

import time
from dataclasses import dataclass

from .config import RouterConfig
from .quota import QuotaCache
from .leaderboard import LeaderboardCache
from .dispatchers.base import BaseDispatcher, DispatchResult

_CIRCUIT_BREAKER_THRESHOLD = 5
_CIRCUIT_BREAKER_DEFAULT_COOLDOWN = 300  # seconds

class CircuitBreaker:
    """Per-service circuit breaker with dynamic cooldown from provider responses."""

    def __init__(self):
        self.failures: int = 0
        self.tripped_at: float | None = None
        self.cooldown: float = _CIRCUIT_BREAKER_DEFAULT_COOLDOWN

    @property
    def is_tripped(self) -> bool:
        if self.tripped_at is None:
            return False
        if time.monotonic() - self.tripped_at >= self.cooldown:
            self._reset()
            return False
        return True

    def record_failure(self, retry_after: float | None = None) -> None:
        self.failures += 1
        if self.failures >= _CIRCUIT_BREAKER_THRESHOLD:
            self.tripped_at = time.monotonic()
            self.cooldown = retry_after if (retry_after and retry_after > 0) else _CIRCUIT_BREAKER_DEFAULT_COOLDOWN

    def record_success(self) -> None:
        self._reset()

    def trip(self, retry_after: float | None = None) -> None:
        """Immediately trip — use on 429 or explicit rate-limit response."""
        self.tripped_at = time.monotonic()
        self.cooldown = retry_after if (retry_after and retry_after > 0) else _CIRCUIT_BREAKER_DEFAULT_COOLDOWN

    def _reset(self) -> None:
        self.failures = 0
        self.tripped_at = None
        self.cooldown = _CIRCUIT_BREAKER_DEFAULT_COOLDOWN

    def cooldown_remaining(self) -> float:
        if not self.is_tripped:
            return 0.0
        return max(0.0, self.cooldown - (time.monotonic() - self.tripped_at))

    def status(self) -> dict:
        if not self.is_tripped:
            return {"tripped": False, "failures": self.failures}
        return {
            "tripped": True,
            "failures": self.failures,
            "cooldown_remaining_seconds": round(self.cooldown_remaining(), 1),
        }

@dataclass
class RoutingDecision:
    """Explains why a service was selected."""
    service: str
    tier: int
    quota_score: float
    quality_score: float      # normalized_elo × thinking_mult
    cli_capability: float     # CLI agent amplification factor
    capability_score: float   # capabilities[task_type] — task-type fit score
    task_type: str            # "execute" | "plan" | "review" | ""
    model: str | None      # resolved model to dispatch with (may differ from config default)
    elo: float | None
    final_score: float        # quality_score × cli_capability × capability_score × quota_score × weight
    reason: str

async def _dispatch_with_model(
    dispatcher,
    prompt: str,
    files: list[str],
    working_dir: str,
    model: str | None,
):
    """Call dispatcher.dispatch(), passing model_override if the dispatcher supports it."""
    try:
        return await dispatcher.dispatch(prompt, files, working_dir, model_override=model)
    except TypeError:
        # Dispatcher doesn't accept model_override (e.g. Gemini, Codex, Cursor)
        return await dispatcher.dispatch(prompt, files, working_dir)

def _resolve_model(svc, task_type: str) -> str | None:
    """Return the model to use for this service+task_type combination.

    If the service has escalate_model set and task_type is in escalate_on,
    returns escalate_model. Otherwise returns the default model (or None).
    """
    if svc.escalate_model and task_type in svc.escalate_on:
        return svc.escalate_model
    return svc.model

class Router:
    """Routes coding tasks to the best available service using tiered selection."""

    def __init__(
        self,
        config: RouterConfig,
        quota: QuotaCache,
        dispatchers: dict[str, BaseDispatcher],
        leaderboard: LeaderboardCache,
    ):
        self.config = config
        self.quota = quota
        self.dispatchers = dispatchers
        self.leaderboard = leaderboard
        self._breakers: dict[str, CircuitBreaker] = {
            name: CircuitBreaker() for name in config.services
        }

    async def pick_service(
        self,
        hints: dict = None,
        prompt: str = "",
        files: list[str] = None,
        exclude: set[str] = None,
    ) -> RoutingDecision | None:
        """
        Select the best available service using tiered routing.

        Args:
            hints:   Explicit routing hints from the caller.
            prompt:  Passed through for context (not used for auto-classification).
            files:   Used for context-size hint only if prefer_large_context is set.
            exclude: Service names to skip (used by fallback logic).

        Returns a RoutingDecision, or None if no service is available.
        """
        hints = hints or {}
        files = files or []
        exclude = exclude or set()
        force_service = hints.get("service")
        prefer_large_context = hints.get("prefer_large_context", False)
        task_type = hints.get("task_type", "")  # "execute" | "plan" | "review" | "local" | ""
        # harness hint: restrict candidates to services using a specific CLI harness.
        # E.g. hints={"harness": "cursor"} picks the best available cursor-harness service.
        filter_harness = hints.get("harness")

        # --- Forced service ---
        if force_service:
            if force_service not in self.dispatchers or force_service in exclude:
                return None
            breaker = self._breakers.get(force_service)
            if breaker and breaker.is_tripped:
                return None
            dispatcher = self.dispatchers[force_service]
            if not getattr(dispatcher, "is_available", lambda: True)():
                return None
            svc = self.config.services[force_service]
            quota_score = await self.quota.get_quota_score(force_service)
            quality_score, elo = await self.leaderboard.get_quality_score(
                svc.leaderboard_model, svc.thinking_level
            )
            cap_score = svc.capabilities.get(task_type, 1.0) if task_type in ("execute", "plan", "review") else 1.0
            return RoutingDecision(
                service=force_service,
                tier=svc.tier,
                quota_score=quota_score,
                quality_score=quality_score,
                cli_capability=svc.cli_capability,
                capability_score=cap_score,
                task_type=task_type,
                model=_resolve_model(svc, task_type),
                elo=elo,
                final_score=quality_score * svc.cli_capability * cap_score * quota_score * svc.weight,
                reason="forced",
            )

        # --- Build per-tier candidate lists ---
        tier_candidates: dict[int, list] = {}

        for name, svc in self.config.services.items():
            if not svc.enabled or name not in self.dispatchers:
                continue
            if name in exclude:
                continue
            if self._breakers[name].is_tripped:
                continue
            dispatcher = self.dispatchers[name]
            if not getattr(dispatcher, "is_available", lambda: True)():
                continue
            # harness hint: skip services that don't match the requested harness
            if filter_harness and (svc.harness or name) != filter_harness:
                continue

            # Auto-derive tier from ELO if leaderboard_model is configured
            if svc.leaderboard_model:
                tier = await self.leaderboard.auto_tier(
                    svc.leaderboard_model,
                    svc.thinking_level,
                    fallback_tier=svc.tier,
                )
            else:
                tier = svc.tier

            quota_score = await self.quota.get_quota_score(name)
            quality_score, elo = await self.leaderboard.get_quality_score(
                svc.leaderboard_model, svc.thinking_level
            )

            # Per-task-type capability multiplier — captures where each service
            # objectively excels vs. struggles beyond raw ELO.
            cap_score = svc.capabilities.get(task_type, 1.0) if task_type in ("execute", "plan", "review") else 1.0

            # cli_capability multiplies ELO quality — captures agent scaffolding
            # value that the leaderboard (raw API calls) doesn't measure.
            effective_quality = quality_score * svc.cli_capability * cap_score

            score = effective_quality * quota_score * svc.weight

            # Infrastructure-level hint adjustments
            # Boost any gemini-cli harness service for large-context tasks (1M window)
            if prefer_large_context and (svc.harness or name) in ("gemini", "gemini_cli"):
                score += 0.3
            if task_type == "local" and svc.type == "openai_compatible":
                if svc.base_url and ("localhost" in svc.base_url or "127.0.0.1" in svc.base_url):
                    score += 0.3

            tier_candidates.setdefault(tier, []).append(
                (score, name, quota_score, quality_score, elo, svc.cli_capability, cap_score)
            )

        if not tier_candidates:
            return None

        # Minimum tier across all configured+enabled services — used to detect
        # when we've fallen back past the intended primary tier.
        min_configured_tier = min(
            svc.tier for svc in self.config.services.values() if svc.enabled
        )

        # --- Select from the highest-quality available tier ---
        sorted_tiers = sorted(tier_candidates.keys())
        for tier in sorted_tiers:
            candidates = tier_candidates[tier]
            if not candidates:
                continue
            candidates.sort(key=lambda x: x[0], reverse=True)
            best_score, best_name, best_quota, best_quality, best_elo, best_cli, best_cap = candidates[0]
            svc = self.config.services[best_name]

            tier_count = len(candidates)
            if tier > min_configured_tier:
                reason = f"tier {tier} fallback (all tier {min_configured_tier} services exhausted)"
            else:
                reason = f"tier {tier} best ({tier_count} available)"

            return RoutingDecision(
                service=best_name,
                tier=tier,
                quota_score=best_quota,
                quality_score=best_quality,
                cli_capability=best_cli,
                capability_score=best_cap,
                task_type=task_type,
                model=_resolve_model(self.config.services[best_name], task_type),
                elo=best_elo,
                final_score=best_score,
                reason=reason,
            )

        return None

    async def route(
        self,
        prompt: str,
        files: list[str],
        working_dir: str,
        hints: dict = None,
        max_fallbacks: int = 2,
    ) -> tuple[DispatchResult, RoutingDecision | None]:
        """
        Route a task, with automatic fallback on transient failures.

        If the picked service fails (non-rate-limit), the next-best service
        is tried automatically, up to max_fallbacks additional attempts.
        Returns (result, decision) for the attempt that succeeded (or the
        last failure if all attempts fail).
        """
        hints = hints or {}
        tried: set[str] = set()
        last_result: DispatchResult | None = None
        last_decision: RoutingDecision | None = None

        for attempt in range(max_fallbacks + 1):
            decision = await self.pick_service(
                hints=hints, prompt=prompt, files=files, exclude=tried
            )

            if decision is None:
                if last_result is not None:
                    return last_result, last_decision
                breaker_info = {n: b.status() for n, b in self._breakers.items()}
                return DispatchResult(
                    output="", service="none", success=False,
                    error=(
                        "No available services — all are disabled, exhausted, or circuit-broken. "
                        f"Breaker state: {breaker_info}"
                    ),
                ), None

            result = await _dispatch_with_model(
                self.dispatchers[decision.service], prompt, files, working_dir, decision.model
            )
            self._handle_result(decision.service, result)
            last_result = result
            last_decision = decision

            if result.success:
                if attempt > 0:
                    decision.reason += f" (fallback #{attempt} — prev failed)"
                return result, decision

            # Rate-limited: don't retry, circuit breaker already tripped
            if result.rate_limited:
                return result, decision

            # Transient failure: exclude this service and try again
            tried.add(decision.service)

        return last_result, last_decision

    async def route_to(
        self,
        service: str,
        prompt: str,
        files: list[str],
        working_dir: str,
    ) -> tuple[DispatchResult, RoutingDecision | None]:
        """Dispatch to a specific service. Returns (result, decision)."""
        if service not in self.dispatchers:
            return DispatchResult(
                output="", service=service, success=False,
                error=f"Unknown service: {service}",
            ), None

        breaker = self._breakers.get(service)
        if breaker and breaker.is_tripped:
            cd = round(breaker.cooldown_remaining(), 1)
            return DispatchResult(
                output="", service=service, success=False,
                error=f"'{service}' is circuit-broken — {cd}s cooldown remaining",
            ), None

        svc = self.config.services[service]
        quota_score = await self.quota.get_quota_score(service)
        quality_score, elo = await self.leaderboard.get_quality_score(
            svc.leaderboard_model, svc.thinking_level
        )
        decision = RoutingDecision(
            service=service,
            tier=svc.tier,
            quota_score=quota_score,
            quality_score=quality_score,
            cli_capability=svc.cli_capability,
            capability_score=1.0,  # no task_type context when called directly
            task_type="",
            model=svc.model,  # no task_type → use default model, no escalation
            elo=elo,
            final_score=quality_score * svc.cli_capability * quota_score * svc.weight,
            reason="explicit",
        )
        result = await _dispatch_with_model(
            self.dispatchers[service], prompt, files, working_dir, decision.model
        )
        self._handle_result(service, result)
        return result, decision

    def _handle_result(self, service: str, result: DispatchResult) -> None:
        self.quota.record_result(service, result)
        breaker = self._breakers[service]
        if result.success:
            breaker.record_success()
        elif result.rate_limited:
            breaker.trip(retry_after=result.retry_after)
        else:
            breaker.record_failure(retry_after=result.retry_after)

    def circuit_breaker_status(self) -> dict[str, dict]:
        return {name: b.status() for name, b in self._breakers.items()}
