# coding-agent-mcp

An MCP server that routes coding tasks across multiple AI CLI agents — Claude Code, Cursor, Codex, and Gemini CLI — with quota-aware load balancing, circuit breaking, and intelligent task-type routing.

## Architecture: model x harness

Each configured service is a **(model, harness)** pair. The harness is the CLI agent scaffold (which adds agentic value beyond the raw model API); the model is the exact string passed via `--model`.

```
claude_code_opus  = claude-opus-4-6            x claude_code harness
cursor_sonnet     = claude-sonnet-4-6          x cursor harness
codex_gpt54       = gpt-5.4                    x codex harness
gemini31pro       = gemini-3.1-pro-preview     x gemini_cli harness
```

The same model in different harnesses gets different scores. Cursor's codebase indexing and Claude Code's file/bash tools produce meaningfully different results on the same underlying model, which is why `cli_capability` is a separate multiplier from ELO.

## MCP tools

| Tool | Description |
|------|-------------|
| `code_auto` | Auto-route to the best available service. Accepts `hints` for task type, harness, or context size. |
| `code_mixture` | Dispatch to multiple services in parallel and return all outputs for synthesis. |
| `code_with_claude` | Route to any enabled `claude_code` harness service. |
| `code_with_cursor` | Route to any enabled `cursor` harness service. |
| `code_with_codex` | Route to any enabled `codex` harness service. |
| `code_with_gemini` | Route to any enabled `gemini_cli` harness service. |
| `get_quota_status` | JSON summary of quota usage and circuit-breaker state per service. |
| `list_available_services` | JSON listing of which services are enabled and CLI-reachable. |
| `dashboard` | Formatted overview of all services, tiers, ELO scores, and quota state. |
| `setup` | Guided setup: checks CLI auth, quota access, and config validity. |

### Routing hints

Pass `hints` to `code_auto` or `code_mixture` to influence routing:

```json
{ "task_type": "execute" }          // execute | plan | review | local
{ "harness": "cursor" }             // restrict to a specific harness
{ "prefer_large_context": true }    // boost Gemini (1M token context)
{ "service": "claude_code_opus" }   // force a specific service
```

## Scoring

Each service is scored per task:

```
score = quality_score × cli_capability × capabilities[task_type] × quota_score × weight
```

Where `quality_score = normalized_elo × thinking_mult`, and:

- **normalized_elo** — ELO score mapped to [0.60, 1.00]. Source priority: (1) `data/coding_benchmarks.json` blended score (Arena + Aider + SWE-bench) if present, (2) live Arena AI Code leaderboard (24h cached), (3) 0.85 default.
- **thinking_mult** — 1.00 (none/low) | 1.07 (medium) | 1.15 (high). Applies when `thinking_level` is set on the service.
- **cli_capability** — harness amplification factor set in `config.yaml`. Captures how much the agentic scaffold adds beyond raw model ELO. Reference points: `claude_code` 1.10, `codex` 1.08, `cursor` 1.05, `gemini_cli` 1.00.
- **capabilities** — per-service relative strength for `execute` / `plan` / `review`. 1.0 = best in class; values below 1.0 represent weaker fit for that task type.
- **quota_score** — live availability [0, 1], tracked automatically per service.
- **weight** — static preference multiplier from config (default 1.0).

Services are grouped into tiers (Frontier / Strong / Fast) based on ELO. The router always tries tier 1 first and falls back only when all tier-1 services are circuit-broken or quota-exhausted. Tier thresholds: ELO >= 1350 = tier 1, ELO >= 1200 = tier 2, ELO < 1200 = tier 3. When `thinking_level: high` is set, the threshold relaxes by 25 ELO points.

### Model escalation

A service can automatically escalate to a stronger model for reasoning-heavy task types:

```yaml
claude_code_sonnet:
  model: claude-sonnet-4-6
  escalate_model: claude-opus-4-6
  escalate_on: [plan, review]   # Sonnet for execute, Opus for plan/review
```

`code_auto` resolves the right model per task before dispatch, so you get Sonnet speed on execution and Opus depth on design decisions without manual switching.

## Prerequisites

- **Python 3.13+**
- **uv and uvx** (recommended, for on-demand Python package installation)
- **Node.js 18+** (if installing via npm)
- **CLI tools** — at least one of: `claude` (Claude Code), `codex`, `gemini`, or Cursor

## Installation

### Option A: npm (recommended)

No cloning or Python setup needed. The npm wrapper installs the Python package on demand via `uvx`.

```bash
# One-time setup
npx coding-agent-mcp

# Or install globally
npm install -g coding-agent-mcp
coding-agent-mcp
```

Then configure `config.yaml` (see below).

### Option B: Python direct

Clone the repository and install:

```bash
git clone https://github.com/fstubner/coding-agent-mcp.git
cd coding-agent-mcp
pip install -e .
```

Or install from PyPI:

```bash
pip install coding-agent-mcp
```

## CLI Authentication

Authenticate each CLI you want to use:

```bash
# Claude Code CLI (requires Claude Pro / Max)
claude auth login

# Codex CLI (requires ChatGPT Pro)
codex auth login

# Gemini CLI (set GEMINI_API_KEY or run auth)
gemini auth
export GEMINI_API_KEY="your-api-key"

# Cursor — sign in via the Cursor desktop app
```

## Configuration

The server works with no config file at all — on startup it probes your PATH for installed CLIs (`claude`, `codex`, `gemini`, `agent`) and uses built-in defaults for each one found.

If you need to pass an API key or tweak something, create a `config.yaml` (or point `CODING_AGENT_CONFIG` to a custom path):

```yaml
# Minimal — just supply the Gemini API key
gemini_api_key: ${GEMINI_API_KEY}
```

That's it for most setups. Other available fields:

```yaml
# Skip a CLI even if it's installed
disabled: [cursor]

# Add local or third-party endpoints that can't be auto-detected
endpoints:
  - name: ollama
    base_url: http://localhost:11434/v1
    model: llama3.2
    tier: 3

# Tweak auto-detected defaults without a full config
overrides:
  claude_code:
    weight: 1.2
  gemini_cli:
    thinking_level: medium
```

### Advanced configuration

For full control — custom models per service, multiple entries per harness, per-task capability scores, model escalation — see `config.example.yaml`. That format is also fully supported: if your config file has a `services:` key the server uses it as-is.

## Claude Desktop / Cursor Integration

### macOS

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "coding-agent": {
      "command": "npx",
      "args": ["coding-agent-mcp"],
      "env": {
        "CODING_AGENT_CONFIG": "/path/to/config.yaml",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

### Windows

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "coding-agent": {
      "command": "npx",
      "args": ["coding-agent-mcp"],
      "env": {
        "CODING_AGENT_CONFIG": "C:\\path\\to\\config.yaml",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

Alternatively, if using Python directly:

```json
{
  "mcpServers": {
    "coding-agent": {
      "command": "python",
      "args": ["-m", "coding_agent"],
      "env": {
        "CODING_AGENT_CONFIG": "/path/to/config.yaml",
        "GEMINI_API_KEY": "your-gemini-key"
      }
    }
  }
}
```

Restart Claude Desktop after updating the config.

## Adding a new service

Any (model, harness) combination can be added to `config.yaml`. The `harness` field selects the dispatcher; the `model` string is passed via `--model` to the CLI. Each enabled entry auto-generates a `code_with_<name>` MCP tool.

```yaml
cursor_opus:
  enabled: true
  harness: cursor
  command: agent
  model: claude-opus-4-6-thinking-max
  tier: 1
  leaderboard_model: "claude-opus-4-6"
  cli_capability: 1.05
  weight: 1.0
  capabilities:
    execute: 0.94
    plan:    0.97
    review:  0.96
```

OpenAI-compatible local endpoints (Ollama, LM Studio, OpenRouter) are also supported:

```yaml
ollama_local:
  enabled: true
  type: openai_compatible
  base_url: http://localhost:11434/v1
  model: llama3.2
  api_key: ""
  tier: 3
  weight: 0.6
```

## Cowork Plugin

A Cowork plugin is available at `coding-agent.plugin` for integrated skill management and scheduling within the Cowork environment.
