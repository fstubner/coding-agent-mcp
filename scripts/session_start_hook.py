#!/usr/bin/env python3
"""
coding-agent SessionStart hook.

Installed by `setup` MCP tool into ~/.claude/hooks.json.
Runs at the start of every Claude Code session and prints routing
instructions so Claude knows to delegate coding tasks to the router.

Claude Code hook protocol:
  - stdin:  JSON event with session info
  - stdout: text printed as a system-level context injection
  - stderr: ignored (use for debug only)
  - exit 0: proceed normally
  - exit 2: block the session (do not use here)
"""

import json
import sys

ROUTING_CONTEXT = """
## Active: coding-agent MCP

The coding-agent MCP server is connected. For ALL coding tasks, route through
it instead of answering directly. Use code_auto with the right task_type:

  task_type=execute  → Codex/Cursor  (tests, patches, autonomous coding)
  task_type=plan     → Claude Opus   (architecture, design, reasoning)
  task_type=review   → Claude Opus   (code review, security, refactoring)

For multiple model perspectives: code_mixture(prompt=..., task_type="plan")
Run dashboard to check service health. You are the orchestrator — delegate.
""".strip()


def main():
    try:
        event = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, Exception):
        event = {}

    # Only inject on session start, not on every tool call
    hook_type = event.get("hook_type", "")
    if hook_type and hook_type != "SessionStart":
        sys.exit(0)

    print(ROUTING_CONTEXT)
    sys.exit(0)


if __name__ == "__main__":
    main()
