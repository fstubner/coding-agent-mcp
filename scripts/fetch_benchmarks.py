#!/usr/bin/env python3
"""
fetch_benchmarks.py — refresh data/coding_benchmarks.json

Fetches model quality scores from multiple coding benchmark sources and
writes a merged JSON file. Run this periodically (e.g. monthly) or when
adding new services to the config.

Usage:
    python scripts/fetch_benchmarks.py

Output:
    data/coding_benchmarks.json

Sources used (in order of reliability for coding tasks):
  1. Arena AI Code leaderboard — human preference votes on code-specific tasks.
     API: https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code
     Coverage: ~59 frontier models, updated daily.

  2. Aider polyglot leaderboard — pass_rate_2 on 225 multi-language code editing
     tasks (Python, TypeScript, Go, Rust, etc.).
     Source: https://github.com/Aider-AI/aider (raw YAML)
     Coverage: ~69 entries, mix of frontier and older models.

  3. Bundled SWE-bench / Terminal Bench scores — hand-curated from published
     benchmark posts. Edit the BUNDLED_SCORES dict below to update.
     SWE-bench Verified measures ability to resolve real GitHub issues.
     Terminal Bench measures full CLI agent on real terminal tasks.

The final "coding_score" per model is a weighted blend:
  arena_code   60%   (live, broad, coding-specific)
  aider        25%   (objective pass rate, code editing focus)
  swebench     15%   (agent-level issue resolution)
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Dict, Optional
from urllib.request import urlopen, Request

# ---------------------------------------------------------------------------
# Output path
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_OUTPUT = os.path.join(_HERE, "..", "data", "coding_benchmarks.json")

# ---------------------------------------------------------------------------
# Source 3: Bundled scores (update manually from benchmark pages)
#
# Keys are lowercase model identifiers matching Arena AI / config leaderboard_model.
# swebench: resolve rate [0, 1] on SWE-bench Verified (April 2026)
# terminalbench: pass rate [0, 1] on Terminal Bench 2.0 (March 2026)
# ---------------------------------------------------------------------------

BUNDLED_SCORES: Dict[str, Dict[str, float]] = {
    # Anthropic
    "claude-opus-4-6":                  {"swebench": 0.808, "terminalbench": None},
    "claude-opus-4-6-thinking":         {"swebench": 0.830, "terminalbench": None},
    "claude-sonnet-4-6":                {"swebench": 0.750, "terminalbench": None},
    "claude-opus-4-5-20251101":         {"swebench": 0.809, "terminalbench": None},
    "claude-opus-4-5-20251101-thinking-32k": {"swebench": 0.820, "terminalbench": None},
    # OpenAI
    "gpt-5.4":                          {"swebench": 0.800, "terminalbench": 0.90},
    "gpt-5.4-high":                     {"swebench": 0.820, "terminalbench": 0.90},
    "gpt-5.4-high (codex-harness)":     {"swebench": 0.850, "terminalbench": 0.90},
    "gpt-5.3-codex":                    {"swebench": 0.850, "terminalbench": None},
    "gpt-5.2-chat-latest-20260210":     {"swebench": 0.800, "terminalbench": 0.90},
    # Google
    "gemini-3.1-pro-preview":           {"swebench": 0.806, "terminalbench": None},
    "gemini-3-pro":                     {"swebench": 0.780, "terminalbench": None},
    "gemini-3-flash":                   {"swebench": 0.650, "terminalbench": None},
}


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

def _get(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "coding-agent-mcp/1.0 fetch_benchmarks"})
    with urlopen(req, timeout=10) as resp:
        return resp.read()


def fetch_arena_code() -> Dict[str, float]:
    """Returns {model_id_lower: elo_score}"""
    print("  Fetching Arena AI code leaderboard...", end="", flush=True)
    try:
        data = json.loads(_get(
            "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code"
        ))
        result = {
            m["model"].lower(): float(m["score"])
            for m in data.get("models", [])
            if "model" in m and "score" in m
        }
        print(f" {len(result)} models")
        return result
    except Exception as e:
        print(f" FAILED: {e}")
        return {}


def fetch_aider() -> Dict[str, float]:
    """Returns {model_name_lower: pass_rate_2 (0-100)}"""
    print("  Fetching Aider polyglot leaderboard...", end="", flush=True)
    try:
        import yaml
        raw = _get(
            "https://raw.githubusercontent.com/Aider-AI/aider/main/"
            "aider/website/_data/polyglot_leaderboard.yml"
        ).decode("utf-8")
        entries = yaml.safe_load(raw)
        result = {}
        for e in entries:
            name = e.get("model", "").strip().lower()
            rate = e.get("pass_rate_2")
            if name and rate is not None:
                # Keep the best score if a model appears multiple times
                if name not in result or rate > result[name]:
                    result[name] = float(rate)
        print(f" {len(result)} entries")
        return result
    except Exception as e:
        print(f" FAILED: {e}")
        return {}


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------

_ELO_MIN = 1000
_ELO_MAX = 1600
_QUALITY_MIN = 0.60
_QUALITY_MAX = 1.00


def _norm_elo(elo: float) -> float:
    r = (elo - _ELO_MIN) / (_ELO_MAX - _ELO_MIN)
    r = max(0.0, min(1.0, r))
    return _QUALITY_MIN + (_QUALITY_MAX - _QUALITY_MIN) * r


def _norm_aider(rate: float) -> float:
    """Aider pass_rate_2 is 0–100; map to [0, 1]."""
    return max(0.0, min(1.0, rate / 100.0))


def _norm_swebench(rate: float) -> float:
    """SWE-bench resolve rate is already [0, 1]."""
    return max(0.0, min(1.0, rate))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Fetching coding benchmark data...")

    arena = fetch_arena_code()
    aider = fetch_aider()

    # Collect all known model names
    all_models = set(arena) | set(k.lower() for k in BUNDLED_SCORES)

    results = {}
    for model in sorted(all_models):
        entry: Dict = {"model": model}

        # Arena ELO
        if model in arena:
            elo = arena[model]
            entry["arena_elo"] = elo
            entry["arena_norm"] = round(_norm_elo(elo), 4)

        # Aider pass rate (fuzzy match)
        aider_rate = _aider_lookup(model, aider)
        if aider_rate is not None:
            entry["aider_pass_rate_2"] = round(aider_rate, 1)
            entry["aider_norm"] = round(_norm_aider(aider_rate), 4)

        # Bundled SWE-bench / Terminal Bench
        bundled = BUNDLED_SCORES.get(model)
        if bundled:
            if bundled.get("swebench") is not None:
                entry["swebench"] = bundled["swebench"]
            if bundled.get("terminalbench") is not None:
                entry["terminalbench"] = bundled["terminalbench"]

        # Blended coding score
        entry["coding_score"] = round(_blend(entry), 4)

        results[model] = entry

    # Sort by coding_score descending for readability
    results = dict(
        sorted(results.items(), key=lambda x: x[1].get("coding_score", 0), reverse=True)
    )

    output = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_weights": {"arena_code": 0.60, "aider": 0.25, "swebench": 0.15},
        "models": results,
    }

    os.makedirs(os.path.dirname(_OUTPUT), exist_ok=True)
    with open(_OUTPUT, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"\nSaved {len(results)} models → {os.path.relpath(_OUTPUT)}")
    print("\nTop 10 by coding_score:")
    for model, entry in list(results.items())[:10]:
        print(
            f"  {entry['coding_score']:.3f}  {model}"
            + (f"  (ELO {entry['arena_elo']:.0f})" if "arena_elo" in entry else "")
        )


def _aider_lookup(model: str, aider: Dict[str, float]) -> Optional[float]:
    """
    Look up an Aider pass rate for a model identifier.

    Very conservative matching: only exact matches or cases where the
    same version number appears in both names. This prevents crossing
    model generations (e.g. "claude-opus-4-6" must NOT match "claude-3-opus").
    """
    import re
    if model in aider:
        return aider[model]

    # Extract version tokens from the query (e.g. "4-6", "3.1", "5.4", "20241022")
    versions = re.findall(r"\d[\d.-]+", model)
    if not versions:
        return None  # no version number — too ambiguous

    q = model.lower()
    for key, val in aider.items():
        k = key.lower()
        # Require all version tokens to appear in the Aider key
        if all(v in k for v in versions):
            return val

    return None


def _blend(entry: Dict) -> float:
    """Weighted blend of available normalised scores."""
    arena_w, aider_w, swe_w = 0.60, 0.25, 0.15
    scores = []
    weights = []

    if "arena_norm" in entry:
        scores.append(entry["arena_norm"] * arena_w)
        weights.append(arena_w)
    if "aider_norm" in entry:
        scores.append(entry["aider_norm"] * aider_w)
        weights.append(aider_w)
    if "swebench" in entry:
        scores.append(_norm_swebench(entry["swebench"]) * swe_w)
        weights.append(swe_w)

    if not scores:
        return 0.85  # fallback default

    # Normalise by actual weight sum (handles missing sources gracefully)
    total_w = sum(weights)
    return sum(scores) / total_w


if __name__ == "__main__":
    main()
