# coding-agent-mcp

An MCP server that routes coding tasks across multiple AI CLI agents — Claude Code, Cursor, Codex, and Gemini CLI — with quota-aware load balancing, circuit breaking, and intelligent task-type routing.

## Architecture: model × harness

Each configured service is a **(model, harness)** pair. The harness is the CLI agent scaffold (which adds agentic value beyond the raw model API); the model is the exact string passed via `--model`.

```
claude_code_opus   = claude-opus-4-6   × claude_code harness
cursor_sonnet      = claude-sonnet-4-6 × cursor harness
gpt54_codex        = gpt-5.4           × codex harness
gemini31pro        = pro               × gemini_cli harness
```

The same model in different harnesses gets different scores — Cursor's codebase indexing and Claude Code's file/bash tools produce meaningfully different results on the same model.

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
{ "task_type": "execute" }   // execute | plan | review
{ "harness": "cursor" }      // restrict to a specific harness
{ "prefer_large_context": true }  // boost Gemini (1M token context)
```

## Scoring

Each service is scored per task:

```
score = normalized_elo × thinking_mult × cli_capability
        × capabilities[task_type] × quota_score × weight
```

- **normalized_elo** — Arena Code leaderboard ELO mapped to [0.60, 1.00], fetched daily
- **thinking_mult** — 1.00 (none/low) | 1.07 (medium) | 1.15 (high)
- **cli_capability** — harness amplification factor, set in `config.yaml`
- **capabilities** — per-service relative strength for execute / plan / review
- **quota_score** — live availability [0, 1], tracked automatically
- **weight** — static preference multiplier

Services are grouped into tiers (Frontier / Strong / Fast) based on ELO. The router always tries tier 1 first and falls back only when all tier-1 services are circuit-broken or quota-exhausted.

## Prerequisites

- **Python 3.13+**
- **uv and uvx** (recommended, for on-demand Python package installation)
- **Node.js 18+** (if installing via npm)
- **CLI tools** — at least one of: `claude` (Claude Code), `codex`, `gemini`, or Cursor

## Installation

### Option A: npm (recommended)

No cloning or Python setup needed. The npm wrapper installs the Python package on demand.

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

Configure services in `config.yaml` at the project root (or set `CODING_AGENT_CONFIG` env var for a custom path):

```yaml
timeout_seconds: 120
quota_cache_ttl: 300
state_file: quota_state.json

services:
  claude_code_opus:
    enabled: true
    harness: claude_code
    model: claude-opus-4-6
    tier: 1
    leaderboard_model: "claude-opus-4-6"
    cli_capability: 1.10
    weight: 1.0
    capabilities:
      execute: 0.96
      plan: 1.0
      review: 1.0
  
  cursor_sonnet:
    enabled: true
    harness: cursor
    model: claude-sonnet-4-6
    tier: 2
    cli_capability: 1.05
    weight: 1.0
```

See `config.yaml` for more examples and OpenAI-compatible endpoint setup.

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

Edit `%APPDATA%\Claude\claude_desktop_config.json` (use full path if npx not in PATH):

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

Any (model, harness) combination can be added to `config.yaml`:

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

OpenAI-compatible local endpoints (Ollama, LM Studio, OpenRouter) are also supported — each enabled entry auto-generates a `code_with_<name>` tool. See the commented examples at the bottom of `config.yaml`.

## Cowork Plugin

A Cowork plugin is available at `coding-agent.plugin` for integrated skill management and scheduling within the Cowork environment.
