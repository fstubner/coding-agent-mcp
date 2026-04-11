# Coding Agent — Global Routing Instructions

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

## Model escalation (claude_code)

claude_code automatically picks the right Claude model:
- execute / unspecified → Sonnet 4.6 (fast, cheap, 1M context)
- plan / review → Opus 4.6 (extended thinking, 1M context)

## For multiple perspectives

Use `code_mixture` when the task benefits from different model opinions (architecture
decisions, design tradeoffs, anything where blind spots matter):

```
code_mixture(prompt="<task>", task_type="plan")
```

## Health check

Run `dashboard` if you're unsure about service availability before routing.
