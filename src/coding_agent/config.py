"""Configuration loading for coding-agent-mcp."""

import os
import re
import shutil
from dataclasses import dataclass, field

import yaml

@dataclass
class ServiceConfig:
    name: str
    enabled: bool
    type: str = "cli"               # "cli" | "openai_compatible"
    # harness: which dispatcher class to use. Defaults to service name for backward compat.
    # Canonical values: "claude_code" | "cursor" | "codex" | "gemini_cli" | "openai_compatible"
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
    tier: int = 1
    # thinking_level: controls reasoning depth for supported models.
    # Values: "low" | "medium" | "high" | None (use model default)
    thinking_level: str | None = None
    # leaderboard_model: Arena AI model ID for ELO-based quality scoring.
    leaderboard_model: str | None = None
    # cli_capability: multiplier capturing how much the CLI scaffold adds beyond raw ELO.
    cli_capability: float = 1.0
    # escalate_model: optional model to use for reasoning-heavy task types.
    escalate_model: str | None = None
    # escalate_on: task types that trigger model escalation (default: plan, review)
    escalate_on: list[str] = field(default_factory=lambda: ["plan", "review"])
    # capabilities: per-task-type relative strength scores [0.0 – 1.0].
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

# ---------------------------------------------------------------------------
# Built-in defaults for auto-detected CLIs
# ---------------------------------------------------------------------------
# These are the sensible defaults applied when a CLI is found on PATH.
# Users can override any field via the `overrides` section in config.yaml.

_CLI_DEFAULTS: dict[str, dict] = {
    "claude_code": {
        "command": "claude",
        "harness": "claude_code",
        "leaderboard_model": "claude-opus-4-6",
        "cli_capability": 1.10,
        "tier": 1,
        "capabilities": {"execute": 0.95, "plan": 1.0, "review": 1.0},
    },
    "codex": {
        "command": "codex",
        "harness": "codex",
        "leaderboard_model": "gpt-5.4",
        "cli_capability": 1.08,
        "tier": 1,
        "capabilities": {"execute": 1.0, "plan": 0.83, "review": 0.82},
    },
    "cursor": {
        "command": "agent",
        "harness": "cursor",
        "leaderboard_model": "claude-sonnet-4-6",
        "cli_capability": 1.05,
        "tier": 1,
        "capabilities": {"execute": 1.0, "plan": 0.82, "review": 0.90},
    },
    "gemini_cli": {
        "command": "gemini",
        "harness": "gemini_cli",
        "leaderboard_model": "gemini-3.1-pro-preview",
        "cli_capability": 1.00,
        "tier": 1,
        "thinking_level": "high",
        "capabilities": {"execute": 0.87, "plan": 0.97, "review": 0.95},
    },
}

# ---------------------------------------------------------------------------
# Environment variable interpolation
# ---------------------------------------------------------------------------

_ENV_VAR_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")

def _resolve(value: str | None) -> str | None:
    """Resolve ${ENV_VAR} references. Returns None if var is unset."""
    if not value:
        return value
    m = _ENV_VAR_RE.match(str(value))
    if m:
        return os.environ.get(m.group(1))
    return value

# ---------------------------------------------------------------------------
# Legacy full-format loader (backwards compat)
# ---------------------------------------------------------------------------

def load_config(path: str) -> RouterConfig:
    """Load RouterConfig from a YAML file with a top-level `services:` key."""
    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    services = {}
    for name, svc in (raw.get("services") or {}).items():
        svc_type = svc.get("type", "cli")
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

# ---------------------------------------------------------------------------
# Auto-detect loader (new default)
# ---------------------------------------------------------------------------

def _detect_services(
    disabled: list[str],
    api_keys: dict[str, str],
    overrides: dict[str, dict],
) -> dict[str, ServiceConfig]:
    """Probe PATH for known CLIs and build ServiceConfig entries for each found."""
    services = {}
    for name, defaults in _CLI_DEFAULTS.items():
        if name in disabled:
            continue
        if not shutil.which(defaults["command"]):
            continue
        caps = dict(defaults.get("capabilities", {}))
        override = overrides.get(name, {})
        # Apply override capabilities on top of defaults
        if "capabilities" in override:
            caps.update(override.pop("capabilities"))
        # Merge override fields
        merged = {**defaults, **override}
        services[name] = ServiceConfig(
            name=name,
            enabled=True,
            type="cli",
            harness=merged.get("harness"),
            command=merged["command"],
            api_key=api_keys.get(name),
            model=merged.get("model"),
            weight=float(merged.get("weight", 1.0)),
            tier=int(merged.get("tier", 1)),
            thinking_level=merged.get("thinking_level"),
            leaderboard_model=merged.get("leaderboard_model"),
            cli_capability=float(merged.get("cli_capability", 1.0)),
            capabilities=caps,
            escalate_model=merged.get("escalate_model"),
            escalate_on=merged.get("escalate_on", ["plan", "review"]),
        )
    return services


def load_config_auto(path: str | None = None) -> RouterConfig:
    """
    Build a RouterConfig by auto-detecting installed CLIs, with optional overrides
    from a minimal config file.

    If `path` points to a file with a `services:` key, falls back to load_config()
    for full backwards compatibility.

    Minimal config file format (all fields optional):

        gemini_api_key: ${GEMINI_API_KEY}   # or any api_key_<name>: ...
        disabled: [cursor]                   # CLIs to skip even if installed
        endpoints:                           # local/third-party (can't be auto-detected)
          - name: ollama
            base_url: http://localhost:11434/v1
            model: llama3.2
            tier: 3
        overrides:                           # applied on top of auto-detected defaults
          claude_code:
            weight: 1.2
        timeout_seconds: 120
        quota_cache_ttl: 300
    """
    raw: dict = {}
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
        # Backwards compat: full format has a `services:` key
        if "services" in raw:
            return load_config(path)

    disabled: list[str] = list(raw.get("disabled") or [])
    overrides: dict[str, dict] = dict(raw.get("overrides") or {})

    # Collect API keys — support both `gemini_api_key` shorthand and `api_keys:` dict
    api_keys: dict[str, str] = {}
    raw_api_keys = raw.get("api_keys") or {}
    for k, v in raw_api_keys.items():
        resolved = _resolve(str(v))
        if resolved:
            api_keys[k] = resolved
    # Shorthand: gemini_api_key, codex_api_key, etc.
    for name in _CLI_DEFAULTS:
        shorthand_key = f"{name}_api_key"
        if shorthand_key in raw:
            resolved = _resolve(str(raw[shorthand_key]))
            if resolved:
                api_keys[name] = resolved
    # Top-level gemini_api_key is the most common case
    if "gemini_api_key" in raw:
        resolved = _resolve(str(raw["gemini_api_key"]))
        if resolved:
            api_keys["gemini_cli"] = resolved
    # Also check env directly for Gemini
    if "gemini_cli" not in api_keys:
        gemini_env = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if gemini_env:
            api_keys["gemini_cli"] = gemini_env

    services = _detect_services(disabled, api_keys, overrides)

    # Local/third-party endpoints
    for ep in (raw.get("endpoints") or []):
        name = ep.get("name")
        if not name or not ep.get("base_url") or not ep.get("model"):
            continue
        raw_caps = ep.get("capabilities") or {}
        services[name] = ServiceConfig(
            name=name,
            enabled=ep.get("enabled", True),
            type="openai_compatible",
            base_url=ep["base_url"],
            model=ep["model"],
            api_key=_resolve(ep.get("api_key", "")),
            weight=float(ep.get("weight", 0.6)),
            tier=int(ep.get("tier", 3)),
            leaderboard_model=ep.get("leaderboard_model"),
            capabilities={
                "execute": float(raw_caps.get("execute", 1.0)),
                "plan":    float(raw_caps.get("plan",    1.0)),
                "review":  float(raw_caps.get("review",  1.0)),
            },
        )

    return RouterConfig(
        services=services,
        timeout_seconds=int(raw.get("timeout_seconds", 120)),
        quota_cache_ttl=int(raw.get("quota_cache_ttl", 300)),
        state_file=str(raw.get("state_file", "quota_state.json")),
    )

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

def default_config_path() -> str | None:
    """
    Resolve config path from env var or look for config.yaml at project root.
    Returns None if no config file is found (auto-detect with no overrides).
    """
    env = os.environ.get("CODING_AGENT_CONFIG")
    if env:
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(here))
    candidate = os.path.join(project_root, "config.yaml")
    return candidate if os.path.exists(candidate) else None
