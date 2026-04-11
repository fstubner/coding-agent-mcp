"""Entry point for coding-agent-mcp.

Usage:
  python -m coding_agent            # start MCP server (stdio)
  coding-agent-mcp                  # same — registered via pyproject.toml
  coding-agent-mcp diagnose         # full dashboard diagnostics and exit
"""

import asyncio
import sys

def main():
    if len(sys.argv) > 1 and sys.argv[1] == "diagnose":
        asyncio.run(_diagnose())
    else:
        asyncio.run(_serve())

async def _serve():
    import mcp.server.stdio
    from .server import app
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())

async def _diagnose():
    """Print the full status dashboard to stdout and exit.

    Delegates entirely to _build_dashboard() so the CLI and MCP outputs
    stay in sync automatically — no duplicate logic to maintain.
    """
    from .server import _build_dashboard
    output = await _build_dashboard()
    print(output)

if __name__ == "__main__":
    main()
