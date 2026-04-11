"""Leaderboard-based quality scoring for coding-agent-mcp.

Fetches Arena ELO scores from the public wulong.dev API
(backed by the oolong-tea-2026/arena-ai-leaderboards daily archive)
with a 24-hour cache. Scores are used as routing quality multipliers —
higher ELO → higher routing priority within the same tier.

API reference: https://blog.wulong.dev/posts/i-built-an-auto-updating-archive-of-every-ai-arena-leaderboard/
Endpoint:      https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=text
Schema:        {meta: {...}, models: [{rank, model, vendor, score, ci, votes}]}
"""

import asyncio
import json
import os
import time
from urllib.request import urlopen, Request

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_LEADERBOARD_URL = (
    "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code"
)
# Using the code-specific leaderboard — human preference votes on coding tasks,
# 59 models, updated daily. Scores reflect how models perform on coding queries
# specifically (not general chat). Differs from the text leaderboard because
# coding voters prioritise correctness, code quality, and tool-use reasoning.

# Path to the blended benchmark file produced by scripts/fetch_benchmarks.py.
# When present, its "coding_score" values (blending Arena + Aider + SWE-bench)
# are used instead of Arena ELO alone.
_BENCHMARK_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),   # src/coding_agent/
    "..", "..",                                    # → project root
    "data", "coding_benchmarks.json",
)
_CACHE_TTL = 24 * 3600  # 24 hours — leaderboard updates daily

# Tier auto-derivation thresholds (Arena ELO, calibrated April 2026)
#   Tier 1 Frontier:  Claude Opus 4.6 Thinking ~1504, GPT-5.4 ~1480
#   Tier 2 Strong:    Claude Sonnet 4.6 ~1310, Gemini 2.5 Pro ~1380
#   Tier 3 Fast:      Claude Haiku ~1150, Gemini 2.5 Flash ~1200
TIER1_ELO_MIN = 1350
TIER2_ELO_MIN = 1200
# ELO < TIER2_ELO_MIN → Tier 3

# High thinking mode earns a threshold relaxation (a model right on the
# border gets promoted to the better tier when extended reasoning is on).
_THINKING_THRESHOLD_BOOST = 25

# Thinking level score multipliers — extra quality credit for extended reasoning
THINKING_MULTIPLIERS: dict[str, float] = {
    "high":   1.15,
    "medium": 1.07,
    "low":    1.0,
}

# ELO normalization range → quality_score in [QUALITY_MIN, QUALITY_MAX]
# Scores outside this range are clamped before normalization.
_ELO_NORM_MIN = 1000
_ELO_NORM_MAX = 1600
QUALITY_MIN = 0.60   # lowest quality multiplier (very weak model)
QUALITY_MAX = 1.00   # highest quality multiplier (best-in-class model)
QUALITY_DEFAULT = 0.85  # used when ELO is unknown (conservative midpoint)

# ---------------------------------------------------------------------------
# LeaderboardCache
# ---------------------------------------------------------------------------

class LeaderboardCache:
    """
    Async-safe cache around the Arena AI leaderboard API.

    Usage::

        cache = LeaderboardCache()
        quality, elo = await cache.get_quality_score("claude opus 4.6", "high")
        tier = await cache.auto_tier("claude opus 4.6", "high", fallback_tier=1)
    """

    def __init__(self) -> None:
        self._data: dict[str, float] = {}   # lowercased model name → ELO
        self._fetched_at: float = 0.0
        self._fetch_failed: bool = False     # don't spam on repeated failures
        self._lock = asyncio.Lock()
        # Blended benchmark scores from data/coding_benchmarks.json
        # (produced by scripts/fetch_benchmarks.py). Loaded once at startup.
        self._benchmark: dict[str, float] = {}  # lowercased model → coding_score [0,1]
        self._load_benchmark_file()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def _load_benchmark_file(self) -> None:
        """Load blended benchmark scores from data/coding_benchmarks.json if present."""
        path = os.path.normpath(_BENCHMARK_FILE)
        if not os.path.exists(path):
            return
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._benchmark = {
                k.lower(): float(v.get("coding_score", 0))
                for k, v in data.get("models", {}).items()
                if v.get("coding_score") is not None
            }
        except Exception:
            pass   # file present but malformed — fall back to Arena API

    def benchmark_loaded(self) -> bool:
        """Whether a benchmark file was successfully loaded."""
        return bool(self._benchmark)

    async def get_scores(self) -> dict[str, float]:
        """Return the full {model_name: elo_score} dict (public alias)."""
        return await self._get_scores()

    async def get_elo(self, leaderboard_model: str) -> float | None:
        """
        Look up Arena ELO for a model identifier.

        Matching is case-insensitive substring search.  The query string
        is matched against leaderboard display names, so both
        ``"claude opus 4.6"`` and ``"opus 4.6 thinking"`` would match
        ``"Claude Opus 4.6 (Thinking)"``.

        Returns None if the model is not found or the fetch fails.
        """
        scores = await self._get_scores()
        if not scores or not leaderboard_model:
            return None
        return _fuzzy_match(leaderboard_model, scores)

    async def get_quality_score(
        self,
        leaderboard_model: str | None,
        thinking_level: str | None = None,
    ) -> tuple[float, float | None]:
        """
        Return ``(quality_score, raw_elo)``.

        *quality_score* is in the range [QUALITY_MIN × 1.0, QUALITY_MAX × 1.15]
        and is intended as a multiplicative weight for routing decisions.

        Source priority:
          1. data/coding_benchmarks.json (blended Arena + Aider + SWE-bench)
          2. Live Arena AI Code ELO (normalized)
          3. QUALITY_DEFAULT (0.85) if neither is available

        *raw_elo* is the raw Arena score (for display), or None.
        """
        thinking_mult = THINKING_MULTIPLIERS.get(thinking_level or "", 1.0)

        # 1. Try blended benchmark file first
        if leaderboard_model and self._benchmark:
            bs = _fuzzy_match_score(leaderboard_model, self._benchmark)
            if bs is not None:
                elo = await self.get_elo(leaderboard_model)  # still fetch for display
                return bs * thinking_mult, elo

        # 2. Fall back to live Arena ELO
        elo = await self.get_elo(leaderboard_model) if leaderboard_model else None
        if elo is not None:
            return _normalize_elo(elo) * thinking_mult, elo

        return QUALITY_DEFAULT * thinking_mult, None

    async def auto_tier(
        self,
        leaderboard_model: str | None,
        thinking_level: str | None = None,
        fallback_tier: int = 1,
    ) -> int:
        """
        Derive tier 1/2/3 from Arena ELO.

        High thinking mode relaxes the tier-1 threshold by
        ``_THINKING_THRESHOLD_BOOST`` ELO points, so a border-line model
        with extended reasoning can qualify for a higher tier.

        Falls back to ``fallback_tier`` if the model is unknown.
        """
        elo = await self.get_elo(leaderboard_model) if leaderboard_model else None
        if elo is None:
            return fallback_tier

        boost = _THINKING_THRESHOLD_BOOST if thinking_level == "high" else 0

        if elo + boost >= TIER1_ELO_MIN:
            return 1
        if elo + boost >= TIER2_ELO_MIN:
            return 2
        return 3

    def cache_age_seconds(self) -> float | None:
        """Seconds since last successful fetch, or None if never fetched."""
        if self._fetched_at == 0.0:
            return None
        return time.time() - self._fetched_at

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _get_scores(self) -> dict[str, float]:
        async with self._lock:
            age = time.time() - self._fetched_at
            if self._data and age < _CACHE_TTL:
                return self._data
            # Don't retry if the last fetch failed within the same TTL window
            if self._fetch_failed and age < _CACHE_TTL:
                return self._data
            try:
                scores = await self._fetch()
                if scores:
                    self._data = scores
                    self._fetched_at = time.time()
                    self._fetch_failed = False
            except Exception:
                self._fetch_failed = True
                # Return stale data rather than crashing routing
            return self._data

    async def _fetch(self) -> dict[str, float]:
        loop = asyncio.get_running_loop()

        def _do_fetch() -> dict[str, float]:
            # User-Agent required — the API returns 403 without it
            req = Request(
                _LEADERBOARD_URL,
                headers={"User-Agent": "coding-agent-mcp/1.0 (leaderboard quality scoring)"},
            )
            with urlopen(req, timeout=8) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            models = payload.get("models", [])
            return {
                m["model"].lower(): float(m["score"])
                for m in models
                if "model" in m and "score" in m
            }

        return await loop.run_in_executor(None, _do_fetch)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_elo(elo: float) -> float:
    """Map an ELO score to [QUALITY_MIN, QUALITY_MAX]."""
    ratio = (elo - _ELO_NORM_MIN) / (_ELO_NORM_MAX - _ELO_NORM_MIN)
    ratio = max(0.0, min(1.0, ratio))
    return QUALITY_MIN + (QUALITY_MAX - QUALITY_MIN) * ratio

def _fuzzy_match_score(query: str, scores: dict[str, float]) -> float | None:
    """Like _fuzzy_match but used for the benchmark file coding_score dict."""
    return _fuzzy_match(query, scores)

def _fuzzy_match(query: str, scores: dict[str, float]) -> float | None:
    """
    Case-insensitive partial-match lookup.

    Strategy:
    1. Exact match (after lowercasing).
    2. Query is a substring of a leaderboard name → prefer the shortest match
       (most specific entry that still contains the query).
    3. All query words appear in the leaderboard name (order-insensitive).
    """
    q = query.lower().strip()

    # 1. Exact
    if q in scores:
        return scores[q]

    # 2. Substring — query appears inside a leaderboard entry
    substr_hits = [(k, v) for k, v in scores.items() if q in k]
    if substr_hits:
        return sorted(substr_hits, key=lambda x: len(x[0]))[0][1]

    # 3. All words in query appear in the leaderboard name
    words = q.split()
    word_hits = [(k, v) for k, v in scores.items() if all(w in k for w in words)]
    if word_hits:
        return sorted(word_hits, key=lambda x: len(x[0]))[0][1]

    return None
