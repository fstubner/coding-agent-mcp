#!/usr/bin/env node
/**
 * coding-agent-mcp — npm wrapper
 *
 * Runs the Python MCP server via uvx (recommended) or falls back to
 * a locally installed `coding-agent-mcp` Python package.
 *
 * Claude Desktop / Cursor config:
 *   "command": "npx", "args": ["coding-agent-mcp"]
 */
'use strict';

const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');

function hasCommand(cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);

// Prefer uvx — installs on demand from PyPI, no manual pip needed
if (hasCommand('uvx')) {
  const proc = spawn('uvx', ['coding-agent-mcp', ...args], { stdio: 'inherit' });
  proc.on('exit', (code) => process.exit(code ?? 0));
} else {
  // Fallback: assume user has run `pip install coding-agent-mcp`
  const proc = spawn('python', ['-m', 'coding_agent', ...args], { stdio: 'inherit' });
  proc.on('exit', (code) => process.exit(code ?? 0));
}
