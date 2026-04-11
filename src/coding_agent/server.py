"""MCP server for coding-agent-mcp."""

import asyncio
import json
import os
import re
import shutil
import sys
import time

import mcp.types as types
from mcp.server import Server

from .config import load_config, default_config_path
from .quota import QuotaCache
from .leaderboard import LeaderboardCache
from .dispatchers.gemini import GeminiDispatcher
from .dispatchers.codex import CodexDispatcher
from .dispatchers.cursor import CursorDispatcher
from .dispatchers.claude_code import ClaudeCodeDispatcher
from .dispatchers.openai_compatible import OpenAICompatibleDispatcher
from .dispatchers.base import DispatchResult
from .router import Router, RoutingDecision, _resolve_model, _dispatch_with_model

# ---------------------------------------------------------------------------
# Bootstrap — dispatcher factory (also used by hot-reload)
# ---------------------------------------------------------------------------
#
# Keys are canonical harness names. A service's harness is resolved as:
#   svc.harness or svc.name   (harness field defaults to None; falls back to name)
#
# This allows multiple services to share the same CLI harness with different
# model strings — e.g. cursor_sonnet + cursor_opus both use the "cursor" harness.

_HARNESS_FACTORIES = {
    # Gemini CLI — thin API wrapper, model + thinking injected via settings.json
    "gemini":     lambda svc, t: GeminiDispatcher(command=svc.command, timeout=t, api_key=svc.api_key, model=svc.model, thinking_level=svc.thinking_level),
    "gemini_cli": lambda svc, t: GeminiDispatcher(command=svc.command, timeout=t, api_key=svc.api_key, model=svc.model, thinking_level=svc.thinking_level),
    # Codex CLI — full-auto exec + test runner; model passed as --model
    "codex":      lambda svc, t: CodexDispatcher(command=svc.command, timeout=t, api_key=svc.api_key, model=svc.model),
    # Cursor agent CLI — editor-aware; model passed as --model (80+ options via --list-models)
    "cursor":     lambda svc, t: CursorDispatcher(command=svc.command, timeout=t, model=svc.model),
    # Claude Code CLI — agentic scaffold; model passed as --model (escalation supported)
    "claude_code": lambda svc, t: ClaudeCodeDispatcher(command=svc.command, timeout=t, api_key=svc.api_key, model=svc.model),
}

def _build_dispatchers(config):
    dispatchers = {}
    for name, svc in config.services.items():
        if not svc.enabled:
            continue
        if svc.type == "openai_compatible":
            if not svc.base_url or not svc.model:
                continue
            dispatchers[name] = OpenAICompatibleDispatcher(
                name=name,
                base_url=svc.base_url,
                model=svc.model,
                api_key=svc.api_key or "",
                timeout=config.timeout_seconds,
                thinking_level=svc.thinking_level,
            )
        else:
            # harness field selects dispatcher class; falls back to service name
            harness_key = svc.harness or name
            factory = _HARNESS_FACTORIES.get(harness_key)
            if factory:
                dispatchers[name] = factory(svc, config.timeout_seconds)
    return dispatchers

_config_path = default_config_path()
_config_mtime: float = 0.0
_config = load_config(_config_path)
_dispatchers = _build_dispatchers(_config)
_quota = QuotaCache(
    dispatchers=_dispatchers,
    ttl=_config.quota_cache_ttl,
    state_file=_config.state_file,
)
# Leaderboard cache — shared singleton, survives hot-reloads
_leaderboard = LeaderboardCache()

# ---------------------------------------------------------------------------
# CLI version cache — installed version fetched once per session;
# latest version fetched from npm registry with a 6-hour TTL.
# ---------------------------------------------------------------------------

from urllib.request import urlopen as _urlopen

# Maps CLI command name → npm package name (for update checks)
_NPM_PACKAGES: dict[str, str] = {
    "gemini": "@google/gemini-cli",
    "codex":  "@openai/codex",
    "claude": "@anthropic-ai/claude-code",
    # "agent" (cursor) is distributed via cursor.com, not npm
}

_installed_version_cache: dict[str, str | None] = {}
_latest_version_cache: dict[str, tuple[str | None, float]] = {}  # pkg → (version, fetched_at)
_LATEST_VERSION_TTL = 6 * 3600  # 6 hours

async def _get_installed_version(command: str) -> str | None:
    """Run `command --version`, cache for the session lifetime."""
    if command in _installed_version_cache:
        return _installed_version_cache[command]

    resolved = shutil.which(command)
    if not resolved:
        _installed_version_cache[command] = None
        return None

    if sys.platform == "win32" and os.path.splitext(resolved)[1].lower() in (".cmd", ".bat"):
        cmd_args = ["cmd", "/c", command, "--version"]
    else:
        cmd_args = [command, "--version"]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
        output = (stdout or stderr).decode("utf-8", errors="replace").strip()
        m = re.search(r"v?(\d+\.\d+[\w.\-]*)", output)
        version = m.group(0) if m else (output.splitlines()[0][:40] if output else None)
    except Exception:
        version = None

    _installed_version_cache[command] = version
    return version

async def _get_latest_npm_version(package: str) -> str | None:
    """Fetch latest version from the npm registry, cached with a 6-hour TTL."""
    cached_ver, cached_at = _latest_version_cache.get(package, (None, 0.0))
    if cached_ver is not None and (time.time() - cached_at) < _LATEST_VERSION_TTL:
        return cached_ver

    url = f"https://registry.npmjs.org/{package}/latest"
    try:
        loop = asyncio.get_running_loop()
        def _fetch():
            with _urlopen(url, timeout=5) as resp:
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        data = await loop.run_in_executor(None, _fetch)
        version = data.get("version")
    except Exception:
        version = None

    if version:
        _latest_version_cache[package] = (version, time.time())
    return version

def _parse_semver(v: str) -> tuple:
    """Parse a version string into a comparable tuple."""
    m = re.match(r"v?(\d+)\.(\d+)\.?(\d*)", v)
    if not m:
        return (0, 0, 0)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))

async def _get_version_info(command: str) -> dict:
    """
    Return a dict with:
      installed: str | None
      latest:    str | None   (None if not on npm or fetch failed)
      outdated:  bool | None  (None if unknown)
    """
    installed = await _get_installed_version(command)
    pkg = _NPM_PACKAGES.get(command)
    latest = await _get_latest_npm_version(pkg) if pkg else None

    outdated: bool | None = None
    if installed and latest:
        outdated = _parse_semver(installed) < _parse_semver(latest)

    return {"installed": installed, "latest": latest, "outdated": outdated}

_router = Router(config=_config, quota=_quota, dispatchers=_dispatchers, leaderboard=_leaderboard)

# Lock that serialises hot-reload so concurrent tool calls don't race on global
# state replacement (config/dispatchers/quota/router are all updated atomically).
_reload_lock = asyncio.Lock()

# ---------------------------------------------------------------------------
# Auth status checks — per CLI tool, cached with a TTL
# ---------------------------------------------------------------------------

_AUTH_CACHE_TTL = 300  # seconds — re-check auth after 5 minutes
_auth_cache: dict[str, tuple[str, str, float]] = {}  # command → (icon, description, fetched_at)

# Service-specific auth check commands and output patterns
_AUTH_COMMANDS: dict[str, list] = {
    "claude": ["claude", "auth", "status"],
    "codex":  ["codex",  "login", "status"],  # exits 0 when logged in, prints active auth mode
    # gemini has no non-interactive status command — auth is checked via credential file below
}

# Keywords that indicate a successful auth state in command output
_AUTH_OK_PATTERNS = [
    "logged in", "authenticated", "signed in", "authorized",
    "@",                # email address present → logged in
    "account:",        # account details shown
    "user:",
    "username:",
]
_AUTH_FAIL_PATTERNS = [
    "not logged", "not authenticated", "unauthenticated",
    "login required", "please log in", "please authenticate",
    "no credentials", "unauthorized",
]

async def _check_cli_auth(command: str) -> tuple[str, str]:
    """
    Run `<command> auth status` and return (icon, description).
    Results are cached with a 5-minute TTL (_AUTH_CACHE_TTL) so that
    auth state changes (login/logout) are eventually reflected without
    restarting the server.
    """
    cached = _auth_cache.get(command)
    if cached is not None:
        icon, desc, fetched_at = cached
        if time.time() - fetched_at < _AUTH_CACHE_TTL:
            return icon, desc

    auth_cmd = _AUTH_COMMANDS.get(command)

    # Cursor uses subscription auth — no auth status command
    if command == "agent":
        result = ("✓", "subscription (OAuth via Cursor IDE)")
        _auth_cache[command] = (*result, time.time())
        return result

    # Gemini has no non-interactive status command — check for cached credential files
    if command == "gemini":
        home = os.path.expanduser("~")
        cred_paths = [
            os.path.join(home, ".gemini", "oauth_creds.json"),
            os.path.join(home, ".config", "gemini", "credentials.json"),
            os.path.join(home, ".config", "gcloud", "application_default_credentials.json"),
        ]
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if api_key:
            result = ("✓", "API key (GEMINI_API_KEY set)")
        elif any(os.path.exists(p) for p in cred_paths):
            found = next(p for p in cred_paths if os.path.exists(p))
            result = ("✓", f"OAuth credentials cached ({os.path.basename(found)})")
        else:
            result = ("?", "no credentials found — run: gemini auth (opens browser)")
        _auth_cache[command] = (*result, time.time())
        return result

    if not auth_cmd or not shutil.which(command):
        result = ("?", "unknown (CLI not found)")
        _auth_cache[command] = (*result, time.time())
        return result

    if sys.platform == "win32":
        resolved = shutil.which(command)
        if resolved and os.path.splitext(resolved)[1].lower() in (".cmd", ".bat"):
            auth_cmd = ["cmd", "/c"] + auth_cmd

    try:
        proc = await asyncio.create_subprocess_exec(
            *auth_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},  # suppress prompts/spinners
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
        output = (stdout + stderr).decode("utf-8", errors="replace").lower()
    except Exception:
        result = ("?", "auth check failed (timeout or error)")
        _auth_cache[command] = (*result, time.time())
        return result

    lowered = output.strip()
    if any(p in lowered for p in _AUTH_FAIL_PATTERNS):
        result = ("✗", "not authenticated — run: " + " ".join(auth_cmd[:3] + ["login"]))
    elif any(p in lowered for p in _AUTH_OK_PATTERNS):
        # Try to extract email/username from output for display
        email_match = re.search(r"[\w.+-]+@[\w.-]+\.\w+", output)
        user_match = re.search(r"(?:user(?:name)?|account|logged in as)[:\s]+([^\s,\n]+)", lowered)
        who = email_match.group(0) if email_match else (user_match.group(1) if user_match else None)
        result = ("✓", f"authenticated{f' as {who}' if who else ''}")
    else:
        # Non-empty output but no clear signal — show first line
        first_line = output.splitlines()[0].strip()[:60] if output.strip() else ""
        result = ("?", first_line or "status unknown")

    _auth_cache[command] = (*result, time.time())
    return result

# ---------------------------------------------------------------------------
# Cursor model auto-detection from settings files
# ---------------------------------------------------------------------------

def _detect_cursor_model() -> str | None:
    """
    Try to detect the active Cursor model from its settings files.
    Checks OS-specific Cursor settings paths.
    Returns a model string or None if not detectable.
    """
    # Candidate settings paths by platform
    home = os.path.expanduser("~")
    candidates = []

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        candidates = [
            os.path.join(appdata, "Cursor", "User", "settings.json"),
            os.path.join(home, "AppData", "Roaming", "Cursor", "User", "settings.json"),
        ]
    elif sys.platform == "darwin":
        candidates = [
            os.path.join(home, "Library", "Application Support", "Cursor", "User", "settings.json"),
        ]
    else:
        candidates = [
            os.path.join(home, ".config", "Cursor", "User", "settings.json"),
        ]

    # Keys that might hold the active model
    _MODEL_KEYS = [
        "cursor.chat.model",
        "cursor.composer.model",
        "cursor.agent.model",
        "cursor.defaultModel",
        "cursor.model",
    ]

    for path in candidates:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                settings = json.load(f)
            for key in _MODEL_KEYS:
                val = settings.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
        except Exception:
            continue

    return None

# ---------------------------------------------------------------------------
# Config hot-reload — checked on every tool call
# ---------------------------------------------------------------------------

async def _maybe_reload_config() -> bool:
    """
    Check if config.yaml has changed on disk. If so, rebuild dispatchers,
    quota cache, and router in-place. Returns True if a reload happened.
    Circuit-breaker state is preserved across reloads.

    The _reload_lock ensures that concurrent tool calls don't race on global
    state replacement — only the first caller performs the reload, the rest
    pick up the already-reloaded state after the lock is released.
    """
    global _config, _dispatchers, _quota, _router, _config_mtime

    # Fast path — skip the lock if the file hasn't changed
    try:
        mtime = os.path.getmtime(_config_path)
    except OSError:
        return False
    if mtime <= _config_mtime:
        return False

    async with _reload_lock:
        # Re-check after acquiring the lock (another task may have already reloaded)
        try:
            mtime = os.path.getmtime(_config_path)
        except OSError:
            return False
        if mtime <= _config_mtime:
            return False

        try:
            new_config = load_config(_config_path)
        except Exception:
            return False  # don't crash on a malformed config edit

        new_dispatchers = _build_dispatchers(new_config)
        new_quota = QuotaCache(
            dispatchers=new_dispatchers,
            ttl=new_config.quota_cache_ttl,
            state_file=new_config.state_file,
        )
        # Preserve circuit-breaker state for services that still exist
        old_breakers = _router._breakers
        new_router = Router(config=new_config, quota=new_quota, dispatchers=new_dispatchers, leaderboard=_leaderboard)
        for name, breaker in old_breakers.items():
            if name in new_router._breakers:
                new_router._breakers[name] = breaker

        _config = new_config
        _dispatchers = new_dispatchers
        _quota = new_quota
        _router = new_router
        _config_mtime = mtime
        return True

# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

app = Server("coding-agent")

_PROMPT_SCHEMA = {
    "type": "object",
    "properties": {
        "prompt": {
            "type": "string",
            "description": "The coding task or question.",
        },
        "files": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Absolute file paths to include as context.",
            "default": [],
        },
        "working_dir": {
            "type": "string",
            "description": "Working directory for the CLI process.",
            "default": "",
        },
    },
    "required": ["prompt"],
}

@app.list_tools()
async def list_tools() -> list[types.Tool]:
    tools = [
        types.Tool(
            name="code_with_gemini",
            description=(
                "Route to the best available Gemini CLI (gemini_cli harness) service. "
                "Default: Gemini 3.1 Pro Preview with HIGH thinking (1M token context). "
                "Strengths: plan (97%), review (95%) — ingest entire codebases for full-scope "
                "analysis and planning. Weaker on execute (87%) — thin CLI wrapper, no exec loop. "
                "Falls back to other gemini_cli services if primary is circuit-broken."
            ),
            inputSchema=_PROMPT_SCHEMA,
        ),
        types.Tool(
            name="code_with_codex",
            description=(
                "Route to the best available Codex CLI (codex harness) service. "
                "Default: GPT-5.4 in --full-auto mode (code execution + test runner). "
                "Strengths: execute (100%) — CI-style loops, code execution, test running, "
                "multi-step self-correction. Weaker on plan (83%) and review (82%). "
                "Use for: run tests, apply patches, fix CI failures, autonomous multi-step coding."
            ),
            inputSchema=_PROMPT_SCHEMA,
        ),
        types.Tool(
            name="code_with_cursor",
            description=(
                "Route to the best available Cursor agent CLI (cursor harness) service. "
                "Picks the highest-scoring cursor model for the task — default is Sonnet 4.6 "
                "(fast, SWE-bench Pro 50.21%), with Opus 4.6 available for plan/review when "
                "cursor_opus is enabled. Cursor is editor-aware with full codebase indexing. "
                "Use for: file edits, refactors, UI work, tasks needing editor/project context. "
                "Use code_auto with task_type to get model selection across all harnesses."
            ),
            inputSchema=_PROMPT_SCHEMA,
        ),
        types.Tool(
            name="code_with_claude",
            description=(
                "Route to the best available Claude Code CLI (claude_code harness) service. "
                "Picks Opus 4.6 for plan/review (extended thinking, 100% capability) or "
                "Sonnet 4.6 for execute (fast, 5× cheaper, 96% capability). "
                "Both use the Claude Code agentic scaffold (file ops, bash, 1M context). "
                "Use for: planning, design decisions, architectural critique, deep code review."
            ),
            inputSchema=_PROMPT_SCHEMA,
        ),
        types.Tool(
            name="code_auto",
            description=(
                "Route a coding task to the best available service based on live quota scores, "
                "ELO quality, CLI capability, and per-task-type capability profiles. "
                "Use task_type hint to route objectively: 'execute' for autonomous coding, "
                "'plan' for architecture/design (routes to Claude Opus or Gemini), "
                "'review' for code review/analysis."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}, "default": []},
                    "working_dir": {"type": "string", "default": ""},
                    "hints": {
                        "type": "object",
                        "description": (
                            "Routing hints. "
                            "task_type (str): 'execute' | 'plan' | 'review' | 'local' — "
                            "selects the objectively best service for the task type using "
                            "benchmark-derived capability profiles. "
                            "prefer_large_context (bool): extra boost for Gemini (1M tokens). "
                            "service (str): force a specific provider, skip all routing logic."
                        ),
                        "default": {},
                    },
                },
                "required": ["prompt"],
            },
        ),
        types.Tool(
            name="code_mixture",
            description=(
                "Mixture-of-Agents: send the same prompt to ALL available services in parallel, "
                "then return their responses together so you can synthesize the best answer. "
                "Use for planning, architecture decisions, and design work where different models "
                "have complementary perspectives. Each response is labelled with the service name, "
                "time taken, and capability score for the task type. "
                "Warning: uses quota from every service simultaneously."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}, "default": []},
                    "working_dir": {"type": "string", "default": ""},
                    "task_type": {
                        "type": "string",
                        "description": (
                            "'execute' | 'plan' | 'review' — used to score and label "
                            "each service's response by their capability for that task type. "
                            "Defaults to 'plan'."
                        ),
                        "default": "plan",
                    },
                    "services": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Optional list of specific service names to include. "
                            "Defaults to all enabled, reachable, non-circuit-broken services."
                        ),
                        "default": [],
                    },
                },
                "required": ["prompt"],
            },
        ),
        types.Tool(
            name="get_quota_status",
            description=(
                "Return quota and circuit-breaker status for all services. "
                "Proactive quota checks are cached (quota_cache_ttl seconds); "
                "reactive state is always current."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="list_available_services",
            description="List which coding services are enabled and reachable.",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="dashboard",
            description=(
                "Full status dashboard — reachability, quota, circuit breaker state, "
                "and session call counts for every configured service. "
                "Use this to understand routing health at a glance."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="setup",
            description=(
                "One-time setup: writes routing instructions to ~/.claude/CLAUDE.md so "
                "Claude Code automatically uses the coding-agent tools in every session. "
                "Also installs a SessionStart hook that injects routing context at the "
                "start of each Claude Code session. Safe to run multiple times — "
                "appends only if the routing block is not already present."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "force": {
                        "type": "boolean",
                        "description": "Overwrite existing routing block even if already present.",
                        "default": False,
                    }
                },
            },
        ),
    ]

    # Dynamically register tools for openai_compatible services
    for svc_name, svc in _config.services.items():
        if svc.type == "openai_compatible" and svc.enabled and svc_name in _dispatchers:
            model_info = f"{svc.model} @ {svc.base_url}" if svc.model else svc.base_url
            tools.append(types.Tool(
                name=f"code_with_{svc_name}",
                description=f"Run a coding task using {svc_name} ({model_info}).",
                inputSchema=_PROMPT_SCHEMA,
            ))

    return tools

def _routing_header(decision: RoutingDecision) -> str:
    """One-line routing summary prepended to every response."""
    quota_pct = int(decision.quota_score * 100)
    elo_part = f" | ELO {decision.elo:.0f}" if decision.elo is not None else ""
    quality_pct = int(decision.quality_score * 100)
    cli_part = f" | CLI ×{decision.cli_capability:.2f}" if decision.cli_capability != 1.0 else ""
    task_part = f" | {decision.task_type}" if decision.task_type in ("execute", "plan", "review") else ""
    cap_part = f" | cap {int(decision.capability_score * 100)}%" if decision.capability_score != 1.0 else ""
    model_part = f" | {decision.model}" if decision.model else ""
    return (
        f"[routed → {decision.service}{model_part} | tier {decision.tier}"
        f"{elo_part} | quality {quality_pct}%{cli_part}{task_part}{cap_part} | quota {quota_pct}%"
        f" | {decision.reason}]\n\n"
    )

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    # Hot-reload config if the file has changed on disk
    await _maybe_reload_config()

    prompt = arguments.get("prompt", "")
    files = arguments.get("files", [])
    working_dir = arguments.get("working_dir", "")
    hints = arguments.get("hints", {})

    result = None
    decision = None

    # All code_with_* tools route through the router so quota and
    # circuit-breaker state are always tracked.
    #
    # Harness-based routing: picks the best available service using that CLI,
    # regardless of which model variant is configured (e.g. cursor_sonnet vs
    # cursor_opus). Falls back gracefully if a variant is circuit-broken.
    if name == "code_with_gemini":
        result, decision = await _router.route(
            prompt, files, working_dir, hints={"harness": "gemini_cli"}, max_fallbacks=1
        )
    elif name == "code_with_codex":
        result, decision = await _router.route(
            prompt, files, working_dir, hints={"harness": "codex"}, max_fallbacks=1
        )
    elif name == "code_with_cursor":
        result, decision = await _router.route(
            prompt, files, working_dir, hints={"harness": "cursor"}, max_fallbacks=2
        )
    elif name == "code_with_claude":
        result, decision = await _router.route(
            prompt, files, working_dir, hints={"harness": "claude_code"}, max_fallbacks=1
        )
    elif name.startswith("code_with_") and name[len("code_with_"):] in _dispatchers:
        # Dynamic: code_with_ollama, code_with_lmstudio, etc.
        svc_name = name[len("code_with_"):]
        result, decision = await _router.route_to(svc_name, prompt, files, working_dir)
    elif name == "code_auto":
        result, decision = await _router.route(prompt, files, working_dir, hints, max_fallbacks=2)

    elif name == "code_mixture":
        return await _run_mixture(
            prompt=prompt,
            files=files,
            working_dir=working_dir,
            task_type=arguments.get("task_type", "plan"),
            requested_services=arguments.get("services", []),
        )

    elif name == "get_quota_status":
        quota_status = await _quota.full_status()
        breaker_status = _router.circuit_breaker_status()
        combined = {
            svc: {**quota_status.get(svc, {}), "circuit_breaker": breaker_status.get(svc, {})}
            for svc in set(list(quota_status) + list(breaker_status))
        }
        return [types.TextContent(type="text", text=json.dumps(combined, indent=2))]

    elif name == "list_available_services":
        services = []
        for svc_name, svc in _config.services.items():
            dispatcher = _dispatchers.get(svc_name)
            reachable = getattr(dispatcher, "is_available", lambda: False)()
            score = await _quota.get_quota_score(svc_name)
            breaker = _router.circuit_breaker_status().get(svc_name, {})
            services.append({
                "service": svc_name,
                "tier": svc.tier,
                "enabled": svc.enabled,
                "reachable": reachable,
                "command": svc.command,
                "quota_score": round(score, 3),
                "circuit_breaker": breaker,
            })
        return [types.TextContent(type="text", text=json.dumps(services, indent=2))]

    elif name == "dashboard":
        return [types.TextContent(type="text", text=await _build_dashboard())]

    elif name == "setup":
        force = arguments.get("force", False)
        return [types.TextContent(type="text", text=await _run_setup(force=force))]

    else:
        return [types.TextContent(type="text", text=f"Unknown tool: {name}")]

    # --- Build response for routing tools ---
    header = _routing_header(decision) if decision else ""

    if result.success:
        return [types.TextContent(type="text", text=header + result.output)]

    # Surface circuit-breaker state in error message when rate limited
    error_msg = f"[{result.service} error] {result.error}"
    if result.rate_limited and result.retry_after:
        error_msg += f" (rate limited — retry in {result.retry_after:.0f}s)"
    return [types.TextContent(type="text", text=header + error_msg)]

# ---------------------------------------------------------------------------
# Setup — writes ~/.claude/CLAUDE.md and installs SessionStart hook
# ---------------------------------------------------------------------------

_CLAUDE_MD_BLOCK_START = "<!-- coding-agent-start -->"
_CLAUDE_MD_BLOCK_END   = "<!-- coding-agent-end -->"

_CLAUDE_MD_CONTENT = """\
<!-- coding-agent-start -->
# Coding Router — Global Routing Instructions

For all coding tasks in any project, route through the coding-agent MCP tools
instead of responding directly. You are the orchestrator — delegate, then synthesize.

## When to route

Route any task involving: writing code, fixing bugs, running tests, code review,
architecture decisions, refactoring, debugging, or explaining code.

## How to route

Use `code_auto` with a `task_type` hint that matches what the task actually is:

```
code_auto(
  prompt="<full task description>",
  working_dir="<absolute path to project>",
  hints={"task_type": "execute" | "plan" | "review"}
)
```

| task_type | Use for | Best service |
|-----------|---------|--------------|
| execute | Running tests, applying fixes, autonomous multi-step coding | Codex → Cursor |
| plan | Architecture, design decisions, "how should we build X" | Claude Code (Opus) |
| review | Code review, security audit, explain code, refactor suggestions | Claude Code (Opus) |

## Architecture: (model × harness)

Each service is a (model, harness) pair. The same model in different harnesses
performs differently — e.g. Claude Opus in Claude Code vs Cursor:

  Harnesses: claude_code | cursor | codex | gemini_cli
  Models:    claude-opus-4-6-thinking-max | claude-sonnet-4-6 | gpt-5.4 | ...

`code_auto` picks the best (model, harness) pair for the task type automatically.
`code_with_cursor` picks the best cursor-harness service (may be Sonnet or Opus).

## For multiple perspectives

Use `code_mixture` when the task benefits from different model opinions (architecture
decisions, design tradeoffs, anything where blind spots matter):

  code_mixture(prompt="<task>", task_type="plan")

## Health check

Run `dashboard` if you're unsure about service availability before routing.
<!-- coding-agent-end -->"""

async def _run_setup(force: bool = False) -> str:
    """
    Write routing instructions to ~/.claude/CLAUDE.md and install the
    SessionStart hook in ~/.claude/hooks.json.

    Safe to run multiple times — idempotent unless force=True.
    """
    results = []
    home = os.path.expanduser("~")
    claude_dir = os.path.join(home, ".claude")
    os.makedirs(claude_dir, exist_ok=True)

    # ── 1. Write / update ~/.claude/CLAUDE.md ──────────────────────────────
    claude_md_path = os.path.join(claude_dir, "CLAUDE.md")

    existing = ""
    if os.path.exists(claude_md_path):
        with open(claude_md_path, "r", encoding="utf-8") as f:
            existing = f.read()

    already_present = _CLAUDE_MD_BLOCK_START in existing

    if already_present and not force:
        results.append(f"✓ CLAUDE.md  — routing block already present ({claude_md_path})")
    else:
        if already_present and force:
            # Remove old block before re-inserting
            existing = re.sub(
                rf"{re.escape(_CLAUDE_MD_BLOCK_START)}.*?{re.escape(_CLAUDE_MD_BLOCK_END)}",
                "",
                existing,
                flags=re.DOTALL,
            ).strip()

        new_content = (existing + "\n\n" + _CLAUDE_MD_CONTENT).strip() + "\n"
        with open(claude_md_path, "w", encoding="utf-8") as f:
            f.write(new_content)
        action = "updated" if (already_present and force) else "written"
        results.append(f"✓ CLAUDE.md  — routing block {action} → {claude_md_path}")

    # ── 2. Install SessionStart hook in ~/.claude/hooks.json ───────────────
    hooks_path = os.path.join(claude_dir, "hooks.json")

    # Resolve absolute path to the hook script
    here = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(os.path.dirname(here))
    hook_script = os.path.join(project_root, "scripts", "session_start_hook.py")
    python_exe = sys.executable  # same interpreter running this server

    # Build the hook entry
    hook_entry = {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": f"{python_exe} {hook_script}",
            }
        ],
    }

    existing_hooks: dict = {}
    if os.path.exists(hooks_path):
        try:
            with open(hooks_path, "r", encoding="utf-8") as f:
                existing_hooks = json.load(f)
        except (json.JSONDecodeError, Exception):
            existing_hooks = {}

    session_start_hooks = existing_hooks.get("SessionStart", [])

    # Check if our hook is already registered (by script path)
    already_hooked = any(
        hook_script in str(h)
        for entry in session_start_hooks
        for h in entry.get("hooks", [])
    )

    if already_hooked and not force:
        results.append(f"✓ hooks.json — SessionStart hook already registered ({hooks_path})")
    else:
        if already_hooked and force:
            # Remove old entry for this script
            session_start_hooks = [
                e for e in session_start_hooks
                if not any(hook_script in str(h) for h in e.get("hooks", []))
            ]
        session_start_hooks.append(hook_entry)
        existing_hooks["SessionStart"] = session_start_hooks
        with open(hooks_path, "w", encoding="utf-8") as f:
            json.dump(existing_hooks, f, indent=2)
        action = "updated" if (already_hooked and force) else "installed"
        results.append(f"✓ hooks.json — SessionStart hook {action} → {hooks_path}")

    results.append("")
    results.append("Restart Claude Code to pick up the hook. CLAUDE.md takes effect immediately.")
    results.append("")
    results.append("What this does:")
    results.append("  • CLAUDE.md   — tells Claude to use coding-agent for all coding tasks")
    results.append("  • hooks.json  — injects routing context at the start of every Claude Code session")

    return "\n".join(results)

# ---------------------------------------------------------------------------
# Mixture-of-Agents runner
# ---------------------------------------------------------------------------

async def _run_mixture(
    prompt: str,
    files: list,
    working_dir: str,
    task_type: str = "plan",
    requested_services: list = None,
) -> list[types.TextContent]:
    """
    Fan out the prompt to all available services in parallel, collect their
    responses, and return a structured multi-service result for synthesis.

    The calling model (Claude) synthesises the responses — no extra API call
    needed, since Claude is already orchestrating this MCP tool.
    """
    valid_task_types = ("execute", "plan", "review")
    if task_type not in valid_task_types:
        task_type = "plan"

    # --- Determine which services to call ---
    candidate_services = []
    for svc_name, svc in _config.services.items():
        if not svc.enabled or svc_name not in _dispatchers:
            continue
        # Filter to requested subset if specified
        if requested_services and svc_name not in requested_services:
            continue
        breaker = _router._breakers.get(svc_name)
        if breaker and breaker.is_tripped:
            continue
        dispatcher = _dispatchers[svc_name]
        if not getattr(dispatcher, "is_available", lambda: True)():
            continue
        candidate_services.append(svc_name)

    if not candidate_services:
        return [types.TextContent(
            type="text",
            text="[code_mixture] No available services — all are disabled, exhausted, or circuit-broken.",
        )]

    # --- Pre-fetch quality metadata (for labels) ---
    svc_meta: dict[str, dict] = {}
    for svc_name in candidate_services:
        svc = _config.services[svc_name]
        qs, elo = await _leaderboard.get_quality_score(svc.leaderboard_model, svc.thinking_level)
        cap_score = svc.capabilities.get(task_type, 1.0)
        svc_meta[svc_name] = {
            "quality_score": qs,
            "elo": elo,
            "cli_capability": svc.cli_capability,
            "capability_score": cap_score,
            "effective": qs * svc.cli_capability * cap_score,
        }

    # --- Dispatch to all in parallel ---
    timeout = _config.timeout_seconds

    async def _dispatch_one(svc_name: str):
        start = time.time()
        svc_cfg = _config.services[svc_name]
        resolved_model = _resolve_model(svc_cfg, task_type)
        try:
            result = await asyncio.wait_for(
                _dispatch_with_model(_dispatchers[svc_name], prompt, files, working_dir, resolved_model),
                timeout=timeout,
            )
            elapsed = time.time() - start
            return svc_name, result, elapsed
        except asyncio.TimeoutError:
            elapsed = time.time() - start
            return svc_name, DispatchResult(
                output="", service=svc_name, success=False,
                error=f"timed out after {elapsed:.0f}s",
            ), elapsed
        except Exception as exc:
            elapsed = time.time() - start
            return svc_name, DispatchResult(
                output="", service=svc_name, success=False,
                error=str(exc),
            ), elapsed

    start_total = time.time()
    outcomes = await asyncio.gather(*[_dispatch_one(s) for s in candidate_services])
    total_elapsed = time.time() - start_total

    # Update circuit breakers for all outcomes
    for svc_name, result, _ in outcomes:
        _router._handle_result(svc_name, result)

    # --- Build structured output ---
    succeeded = [o for o in outcomes if o[1].success]
    failed = [o for o in outcomes if not o[1].success]

    lines = [
        "╔═══ MIXTURE OF AGENTS ═══════════════════════════════════════════",
        f"║  task_type : {task_type}",
        f"║  services  : {', '.join(candidate_services)}",
        f"║  completed : {len(succeeded)}/{len(outcomes)} succeeded | total time {total_elapsed:.1f}s",
        "╚═════════════════════════════════════════════════════════════════",
        "",
    ]

    # Sort succeeded by capability score descending (best for task type first)
    succeeded_sorted = sorted(
        succeeded,
        key=lambda o: svc_meta[o[0]]["capability_score"],
        reverse=True,
    )

    for svc_name, result, elapsed in succeeded_sorted:
        meta = svc_meta[svc_name]
        elo_str = f" | ELO {meta['elo']:.0f}" if meta["elo"] else ""
        cap_pct = int(meta["capability_score"] * 100)
        eff_pct = int(meta["effective"] * 100)
        lines.append(
            f"┌─ {svc_name.upper()} ──────────────────────────────────────────────────"
        )
        lines.append(
            f"│  {elapsed:.1f}s{elo_str} | {task_type} capability {cap_pct}% | effective quality {eff_pct}%"
        )
        lines.append("│")
        for line in result.output.splitlines():
            lines.append(f"│  {line}")
        lines.append("└" + "─" * 68)
        lines.append("")

    if failed:
        lines.append("── FAILED SERVICES ─────────────────────────────────────────────")
        for svc_name, result, elapsed in failed:
            lines.append(f"  {svc_name}: {result.error} ({elapsed:.1f}s)")
        lines.append("")

    # Synthesis instruction for the orchestrating model
    ranked = " > ".join(
        o[0] for o in sorted(succeeded_sorted, key=lambda o: svc_meta[o[0]]["effective"], reverse=True)
    )
    lines.append(
        "╔═══ SYNTHESIS GUIDE ══════════════════════════════════════════════"
    )
    lines.append(f"║  Ranked by {task_type} capability: {ranked}")
    lines.append("║  Synthesize the responses above into a unified answer.")
    lines.append("║  Weight insights from higher-ranked services more heavily,")
    lines.append("║  but include unique perspectives from all that succeeded.")
    lines.append("╚══════════════════════════════════════════════════════════════════")

    return [types.TextContent(type="text", text="\n".join(lines))]

# ---------------------------------------------------------------------------
# Dashboard builder
# ---------------------------------------------------------------------------

async def _build_dashboard() -> str:
    quota_status = await _quota.full_status()
    breaker_status = _router.circuit_breaker_status()

    lines = ["coding-agent-mcp — status dashboard", ""]

    # Leaderboard cache status
    lb_age = _leaderboard.cache_age_seconds()
    if lb_age is None:
        lines.append("  leaderboard  : Arena Code ELO — not yet fetched (fetches on first route)")
    elif lb_age < 3600:
        lines.append(f"  leaderboard  : Arena Code ELO cache  ✓ ({lb_age/60:.0f}m old)")
    else:
        lines.append(f"  leaderboard  : Arena Code ELO cache  ({lb_age/3600:.1f}h old — refreshes every 24h)")
    if _leaderboard.benchmark_loaded():
        lines.append("  benchmarks   : data/coding_benchmarks.json loaded ✓  (Arena+Aider+SWEbench blend)")
        lines.append("                 run: python scripts/fetch_benchmarks.py  to refresh")
    else:
        lines.append("  benchmarks   : data/coding_benchmarks.json not found — using Arena ELO only")
        lines.append("                 run: python scripts/fetch_benchmarks.py  to generate")
    lines.append("")

    # Pre-fetch quality scores for all services (reuses cached data)
    quality_scores: dict[str, tuple[float, float | None]] = {}
    auto_tiers: dict[str, int] = {}
    for svc_name, svc in _config.services.items():
        qs, elo = await _leaderboard.get_quality_score(svc.leaderboard_model, svc.thinking_level)
        quality_scores[svc_name] = (qs, elo)
        if svc.leaderboard_model:
            auto_tiers[svc_name] = await _leaderboard.auto_tier(
                svc.leaderboard_model, svc.thinking_level, fallback_tier=svc.tier
            )
        else:
            auto_tiers[svc_name] = svc.tier

    # Group services by auto-derived tier for display
    by_tier: dict[int, list] = {}
    for svc_name, svc in _config.services.items():
        tier = auto_tiers[svc_name]
        by_tier.setdefault(tier, []).append((svc_name, svc))

    for tier in sorted(by_tier.keys()):
        tier_label = {
            1: "Tier 1 — Frontier",
            2: "Tier 2 — Strong",
            3: "Tier 3 — Fast/Local",
        }.get(tier, f"Tier {tier}")
        lines.append(f"── {tier_label} ──────────────────────────────────────")
        lines.append("")

        for svc_name, svc in by_tier[tier]:
            qs, elo = quality_scores[svc_name]
            derived_tier = auto_tiers[svc_name]
            tier_note = ""
            if svc.leaderboard_model and derived_tier != svc.tier:
                tier_note = f"  (config tier {svc.tier} → overridden to {derived_tier} by ELO)"

            if svc.type == "openai_compatible":
                reachable = bool(svc.base_url)
                status_icon = "✓" if (reachable and svc.enabled) else "✗"
                lines.append(f"  [{status_icon}] {svc_name.upper()}{tier_note}")
                lines.append(f"      connection : HTTP API  {svc.base_url or '(no base_url)'}")
                has_key = bool(svc.api_key and svc.api_key.strip())
                lines.append(f"      auth       : API key {'(set)' if has_key else '⚠ (missing)'}")
            else:
                cli_found = shutil.which(svc.command) is not None
                reachable = cli_found
                status_icon = "✓" if (reachable and svc.enabled) else "✗"
                lines.append(f"  [{status_icon}] {svc_name.upper()}{tier_note}")

                if cli_found:
                    vinfo = await _get_version_info(svc.command)
                    installed = vinfo["installed"] or "?"
                    if vinfo["outdated"] is True:
                        ver_note = f"{installed}  ⚠ update available → {vinfo['latest']}"
                    elif vinfo["outdated"] is False:
                        ver_note = f"{installed}  ✓ up to date"
                    else:
                        ver_note = installed
                    lines.append(f"      connection : {svc.command}  ({ver_note})")
                else:
                    lines.append(f"      connection : '{svc.command}' not in PATH")

                auth_icon, auth_desc = await _check_cli_auth(svc.command)
                lines.append(f"      auth       : {auth_icon} {auth_desc}")

            # Quality dimensions: ELO × thinking × CLI capability
            # For Cursor, try to auto-detect the active model from settings
            detected_cursor_model: str | None = None
            if svc.command == "agent":
                detected_cursor_model = _detect_cursor_model()

            model_label = (
                detected_cursor_model
                or svc.leaderboard_model
                or svc.model
                or "?"
            )
            if detected_cursor_model and detected_cursor_model != (svc.leaderboard_model or svc.model):
                model_label = f"{detected_cursor_model}  (auto-detected from Cursor settings)"
            thinking_label = f" + {svc.thinking_level} thinking" if svc.thinking_level else ""
            effective_quality = qs * svc.cli_capability
            cli_label = f" × CLI {svc.cli_capability:.2f}" if svc.cli_capability != 1.0 else ""
            if elo is not None:
                lines.append(
                    f"      quality    : ELO {elo:.0f}{thinking_label}{cli_label}"
                    f"  →  {effective_quality*100:.0f}% effective  ({model_label})"
                )
            else:
                lines.append(
                    f"      quality    : ELO unknown{thinking_label}{cli_label}"
                    f"  →  {effective_quality*100:.0f}% effective"
                    f"  (set leaderboard_model in config)"
                )

            q = quota_status.get(svc_name, {})
            remaining = q.get("remaining")
            limit = q.get("limit")
            score = q.get("score", 1.0)
            source = q.get("source", "unknown")
            calls = q.get("local_call_count", 0)
            age = q.get("updated_age_seconds")

            if remaining is not None and limit is not None:
                pct = int(remaining / limit * 100)
                bar_filled = int(pct / 5)
                bar = "█" * bar_filled + "░" * (20 - bar_filled)
                lines.append(f"      quota      : [{bar}] {pct}%  ({remaining}/{limit})  [{source}]")
            else:
                lines.append(f"      quota      : {int(score * 100)}% assumed available  [{source}]")

            staleness = f"  updated {age:.0f}s ago" if age is not None else ""
            lines.append(f"      calls      : {calls} this session{staleness}")

            b = breaker_status.get(svc_name, {})
            if b.get("tripped"):
                cd = b.get("cooldown_remaining_seconds", "?")
                lines.append(f"      breaker    : ⚡ OPEN — {cd:.0f}s until reset")
            else:
                failures = b.get("failures", 0)
                lines.append(f"      breaker    : closed  ({failures} recent failures)")

            if not svc.enabled:
                lines.append("      note       : disabled in config")

            lines.append("")

    ready = [
        n for n, s in _config.services.items()
        if s.enabled and (shutil.which(s.command) if s.type != "openai_compatible" else bool(s.base_url))
    ]
    lines.append(f"Ready to route: {', '.join(ready) if ready else 'none'}")

    decision = await _router.pick_service()
    if decision:
        elo_part = f" | ELO {decision.elo:.0f}" if decision.elo is not None else ""
        cli_part = f" | CLI ×{decision.cli_capability:.2f}" if decision.cli_capability != 1.0 else ""
        effective_q = decision.quality_score * decision.cli_capability
        lines.append(
            f"Next pick     : {decision.service}"
            f" (tier {decision.tier}{elo_part}{cli_part}"
            f" | effective quality {effective_q*100:.0f}%"
            f" | final score {decision.final_score:.3f})"
        )

    return "\n".join(lines)

# ---------------------------------------------------------------------------
# MCP Prompts (skills) — help text for Claude to use the router effectively
# ---------------------------------------------------------------------------

_PROMPTS = {
    "routing-guide": types.Prompt(
        name="routing-guide",
        description="Capability profiles, routing formula, and when to use each tool (code_auto / code_mixture / direct).",
        arguments=[],
    ),
    "quick-start": types.Prompt(
        name="quick-start",
        description="Quick-start guide for using the coding-agent MCP tools.",
        arguments=[],
    ),
    "debug-routing": types.Prompt(
        name="debug-routing",
        description="Diagnose routing issues — check quota, circuit breakers, and service health.",
        arguments=[],
    ),
}

_PROMPT_CONTENT = {
    "routing-guide": """\
# Coding Router — Routing Guide

## Architecture: (model × harness)

Each service is a (model, harness) pair. "Harness" is the CLI agent scaffold:
  claude_code — Claude Code CLI (file ops, bash, 1M context, agentic scaffold)
  cursor      — Cursor agent CLI (editor-aware, codebase indexing, 80+ models)
  codex       — Codex CLI (full-auto execution, test runner, CI-style loops)
  gemini_cli  — Gemini CLI (1M token context, thin API wrapper, no exec loop)

## Enabled service matrix (April 2026)

| Service            | Model                       | execute | plan | review |
|--------------------|-----------------------------|---------|------|--------|
| claude_code_opus   | claude-opus-4-6             |   93%   | 100% |  100%  |
| claude_code_sonnet | claude-sonnet-4-6           |   96%   |  85% |   88%  |
| gpt54_codex        | gpt-5.4                     |  100%   |  83% |   82%  |
| gemini31pro        | gemini-3.1-pro-preview      |   87%   |  97% |   95%  |
| cursor_sonnet      | claude-sonnet-4-6 (cursor)  |  100%   |  82% |   90%  |

Disabled but available (set enabled: true in config.yaml):
  cursor_opus        — Opus 4.6 thinking-max via Cursor (plan + review)
  cursor_gpt54       — GPT-5.4-max via Cursor (alternative execute)
  cursor_gemini25pro — Gemini 2.5 Pro via Cursor (plan, large context)

## Routing formula

  final_score = ELO_quality × thinking_mult × cli_capability
                × capability[task_type] × quota_score × weight

The router picks the highest-scoring service within the best available tier.

## When to use each tool

**code_auto** — best for most tasks; use task_type hint to route objectively:
  `{"task_type": "execute"}` → gpt54_codex (100%) or cursor_sonnet (100%)
  `{"task_type": "plan"}`   → claude_code_opus (100%) or gemini31pro (97%)
  `{"task_type": "review"}` → claude_code_opus (100%) or gemini31pro (95%)
  `{"harness": "cursor"}`   → restrict to cursor-harness services only
  `{"prefer_large_context": true}` → boosts gemini_cli (1M token window)

**code_mixture** — Mixture of Agents: sends prompt to ALL services in parallel.
  Returns labeled responses from each. You synthesize. Best for:
  - Architecture decisions (get different model "opinions")
  - Planning tasks where blind spots matter
  Warning: uses quota from every service simultaneously.

**code_with_codex** — Routes to best codex-harness service. Full-auto execution
  with test runner. Best for: CI runs, test fixing, patch application.

**code_with_claude** — Routes to best claude_code-harness service. Picks Opus for
  plan/review, Sonnet for execute. Hard reasoning, design, architectural critique.

**code_with_gemini** — Routes to best gemini_cli-harness service. Whole-codebase
  review (1M tokens), planning with full context, broad multi-file analysis.

**code_with_cursor** — Routes to best cursor-harness service. Editor-aware with
  codebase indexing. Good for: file edits, UI work, project-context tasks.

## Response header

Every routing response is prefixed:
  [routed → claude_code | tier 1 | ELO 1543 | quality 93% | CLI ×1.10 | plan | cap 100% | quota 95% | tier 1 best (3 available)]

## Circuit breaker

Each service has a circuit breaker that trips after 5 consecutive failures
(or immediately on a rate-limit 429). The cooldown uses the provider's actual
reset time from response headers.
""",

    "quick-start": """\
# Coding Router — Quick Start

## Available tools

| Tool | What it does |
|------|-------------|
| `code_auto` | Route to best service — use task_type hint for objective routing |
| `code_mixture` | Mixture of Agents — all services in parallel, you synthesize |
| `code_with_gemini` | Force Gemini CLI — best for plan/review with 1M context |
| `code_with_codex` | Force Codex CLI — best for execute (full-auto loop) |
| `code_with_cursor` | Force Cursor — best SWE-bench Pro score, editor-aware |
| `code_with_claude` | Force Claude Code — best for plan + review (Opus, thinking) |
| `dashboard` | Full status: tier groups, quota, capabilities, circuit breakers |
| `get_quota_status` | Raw quota JSON for all services |
| `list_available_services` | Which services are enabled and reachable |

## Routing by task type (objective)

```
# Route to best execution service (Codex or Cursor)
code_auto:
  prompt: "Run the test suite and fix any failures"
  working_dir: "H:/projects/myapp"
  hints: {"task_type": "execute"}

# Route to best planning service (Claude Code Opus)
code_auto:
  prompt: "How should we architect the new auth system?"
  hints: {"task_type": "plan"}

# Route to best review service (Claude Code Opus)
code_auto:
  prompt: "Review this PR for security issues and correctness"
  hints: {"task_type": "review"}

# Get perspectives from all services, then synthesize
code_mixture:
  prompt: "Should we use event sourcing or CQRS for this feature?"
  task_type: "plan"
```

## Checking health

Run `dashboard` to see live tier-grouped status with capability scores for all services.
""",

    "debug-routing": """\
# Coding Router — Debug Routing Issues

## Step 1: Check dashboard

Call `dashboard` to see the full status of all services grouped by tier.
Look for:
- `[✗]` services — CLI not found in PATH or REST API not reachable
- `⚡ OPEN` circuit breakers — service is rate-limited, shows cooldown remaining
- quota score below 10% — service is nearly exhausted
- "Next pick" line at the bottom shows what `code_auto` would select

## Step 2: Verify CLI availability

For each service, confirm the CLI is installed and in PATH:
- Gemini: `gemini --version` in PowerShell
- Codex: `codex --version` in PowerShell
- Cursor: Cursor must be running (REST API on port 9899/9898/9900)
- Claude Code: `claude --version` in PowerShell

## Step 3: Check circuit breaker state

A tripped breaker means the service hit consecutive failures or a rate limit.
It will auto-reset when the provider's reset window expires.
Force-reset not available — wait for cooldown or restart the MCP server.

## Step 4: Test a specific service

Use `code_with_gemini` (or the specific service) with a trivial prompt like
"say hello" to verify end-to-end connectivity without routing.

## Common issues

- **All Tier 1 services exhausted**: Router will fall back to Tier 2 automatically.
  Check the response header — it will say "tier 2 fallback (all tier 1 exhausted)".
- **Cursor not reachable**: Make sure Cursor IDE is open and running
- **Codex auth**: Ensure you're logged in (`codex auth login`)
- **Gemini auth**: Ensure you're logged in (`gemini auth login`)
- **Claude Code auth**: Run `claude auth login` or set ANTHROPIC_API_KEY
""",
}

@app.list_prompts()
async def list_prompts() -> list[types.Prompt]:
    return list(_PROMPTS.values())

@app.get_prompt()
async def get_prompt(name: str, arguments: dict = None) -> types.GetPromptResult:
    content = _PROMPT_CONTENT.get(name)
    if content is None:
        content = f"Unknown prompt: {name}. Available: {', '.join(_PROMPTS)}"
    return types.GetPromptResult(
        description=_PROMPTS.get(name, types.Prompt(name=name, description="")).description,
        messages=[
            types.PromptMessage(
                role="user",
                content=types.TextContent(type="text", text=content),
            )
        ],
    )
