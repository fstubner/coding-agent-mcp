"""Configuration loading for coding-agent-mcp."""

import os
import re
from dataclasses import dataclass, field

import yaml

@dataclass
class ServiceConfig:
    name: str
    enabled: bool
    type: str = "cli"               # "cli" | "openai_compatible"
    # harness: which dispatcher class to use. Defaults to service name for backward compat.
    # Canonical values: "claude_code" | "cursor" | "codex" | "gemini_cli" | "openai_compatible"
    # Set this when you want multiple services using the same CLI but different models,
    # e.g. cursor_sonnet + cursor_opus both have harness: cursor but different model: strings.
    harness: str | None = None
    # CLI fields
    command: str = ""
    # API key — supports ${ENV_VAR} interpolation, resolved at load time
    api_key: str | None = None
    # openai_compatible fields
    base_url: str | None = None  # e.g. http://localhost:11434/v1
    model: str | None = None     # e.g. llama3.2 or claude-opus-4-6-thinking-max
    # Routing weight (score multiplier within a tier)
    weight: float = 1.0
    # Tier — lower number = higher quality = tried first.
    # Tier 1: frontier  (Claude Opus 4.6, GPT-5.4, Gemini 3.1 Pro)
    # Tier 2: strong    (Claude Sonnet, GPT-5.3-Codex, Gemini 2.5 Pro)
    # Tier 3: fast/local (Claude Haiku, GPT-5.4-Mini, Gemini 2.5 Flash, Ollama)
    tier: int = 1
    # thinking_level: controls reasoning depth for supported models.
    # Values: "low" | "medium" | "high" | None (use model default)
    # — Gemini CLI: injected into ~/.gemini/settings.json as thinkingLevel (LOW/MEDIUM/HIGH)
    # — OpenAI-compatible: sent as reasoning_effort in the request body
    # — Claude Code: passed as --thinking-budget flag (if supported by installed version)
    # — Codex CLI: no direct flag; use model choice (gpt-5.4 vs gpt-5.4-mini) instead
    thinking_level: str | None = None
    # leaderboard_model: Arena AI model ID to look up for ELO-based quality scoring.
    # Uses the code-specific Arena leaderboard (human coding preference votes).
    # Case-insensitive substring match against the API model identifiers.
    # Examples: "claude-opus-4-6", "gemini-3.1-pro-preview", "gpt-5.4"
    # Omit (or set to null) to use the explicit tier and default quality weight.
    leaderboard_model: str | None = None
    # cli_capability: multiplier [0.0 – 1.5] capturing how much the CLI agent
    # wrapper amplifies (or limits) the base model's coding ability.
    # The same model called raw vs. through Claude Code's scaffolding vs. through
    # Cursor's agent loop may produce very different real-world results.
    # 1.0  = baseline (raw model, no agentic scaffolding)
    # >1.0 = CLI adds significant value (tool use, file ops, auto-retry, etc.)
    # <1.0 = CLI limits throughput or has quality regressions
    #
    # Reference points (based on SWE-bench Verified April 2026):
    #   claude_code: ~1.10  — dedicated agentic scaffold, strong file editing
    #   codex:       ~1.08  — full-auto exec with test runner + code execution
    #   cursor:      ~1.05  — editor-aware agent, good for file modifications
    #   gemini:      ~1.00  — direct API thin wrapper, minimal scaffolding
    cli_capability: float = 1.0
    # escalate_model: optional model to use for reasoning-heavy task types.
    # When task_type is in escalate_on, the router swaps model for escalate_model.
    # Example: model=claude-sonnet-4-6, escalate_model=claude-opus-4-6
    #          → Sonnet for execute, Opus for plan/review
    escalate_model: str | None = None
    # escalate_on: which task types trigger model escalation (default: plan, review)
    escalate_on: list[str] = field(default_factory=lambda: ["plan", "review"])
    # capabilities: per-task-type relative strength scores [0.0 – 1.0].
    # Used by the router to pick the best service for a given task type.
    # Keys: "execute" | "plan" | "review"
    #
    #   execute — autonomous multi-step coding (SWE-bench, CI-style tasks)
    #   plan    — architecture, design decisions, reasoning-heavy analysis
    #   review  — code review, explanation, refactor suggestions
    #
    # Score of 1.0 = best in class for that task type. These are relative
    # within the set of configured services, not absolute percentages.
    #
    # Default (all 1.0) means the service is treated as equally capable
    # across all task types — only ELO + cli_capability differentiate it.
    capabilities: dict[str, float] = field(default_factory=lambda: {
        "execute": 1.0,
        "plan": 1.0,
        "review": 1.0,
    })

@dataclass
class RouterConfig:
    services: dict[str, ServiceConfig] = field(default_factory=dict)
    timeout_seconds: int = 120
    quota_cache_ttl: int = 300
    state_file: str = "quota_state.json"

_ENV_VAR_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")

def _resolve(value: str | None) -> str | None:
    """Resolve ${ENV_VAR} references. Returns None if var is unset."""
    if not value:
        return value
    m = _ENV_VAR_RE.match(str(value))
    if m:
        resolved = os.environ.get(m.group(1))
        return resolved  # None if env var not set
    return value

def load_config(path: str) -> RouterConfig:
    """Load RouterConfig from a YAML file."""
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    services = {}
    for name, svc in (raw.get("services") or {}).items():
        svc_type = svc.get("type", "cli")
        # Parse per-task-type capability scores
        raw_caps = svc.get("capabilities") or {}
        capabilities = {
            "execute": float(raw_caps.get("execute", 1.0)),
            "plan":    float(raw_caps.get("plan",    1.0)),
            "review":  float(raw_caps.get("review",  1.0)),
        }
        raw_escalate_on = svc.get("escalate_on", ["plan", "review"])
        escalate_on = list(raw_escalate_on) if isinstance(raw_escalate_on, list) else ["plan", "review"]
        services[name] = ServiceConfig(
            name=name,
            enabled=svc.get("enabled", True),
            type=svc_type,
            harness=svc.get("harness"),
            command=svc.get("command", name),
            api_key=_resolve(svc.get("api_key")),
            base_url=svc.get("base_url"),
            model=svc.get("model"),
            weight=float(svc.get("weight", 1.0)),
            tier=int(svc.get("tier", 1)),
            thinking_level=svc.get("thinking_level"),
            leaderboard_model=svc.get("leaderboard_model"),
            cli_capability=float(svc.get("cli_capability", 1.0)),
            capabilities=capabilities,
            escalate_model=svc.get("escalate_model"),
            escalate_on=escalate_on,
        )

    return RouterConfig(
        services=services,
        timeout_seconds=raw.get("timeout_seconds", 120),
        quota_cache_ttl=raw.get("quota_cache_ttl", 300),
        state_file=raw.get("state_file", "quota_state.json"),
    )

def default_config_path() -> str:
    """Resolve config path from env var or relative to project root."""
    env = os.environ.get("CODING_AGENT_CONFIG")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(here))
    return os.path.join(project_root, "config.yaml")
