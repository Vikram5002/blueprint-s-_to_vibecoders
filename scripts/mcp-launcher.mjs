/**
 * Bakes `--mcp` into the command line so an MCP host's own flag parser never
 * sees it. Week 11 found that the Inspector CLI consumes unrecognised flags
 * before they reach the server command — left unwrapped, `--mcp` never
 * arrives, the server starts in normal mode, and the host times out on a
 * stream full of non-JSON. See docs/MCP.md → "Launcher note".
 *
 * Usage: node scripts/mcp-launcher.mjs <repo-path>
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');
const target = process.argv[2];

if (!target) {
  process.stderr.write('usage: node scripts/mcp-launcher.mjs <repo-path>\n');
  process.exit(2);
}

const child = spawn(process.execPath, [cliPath, target, '--mcp'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
