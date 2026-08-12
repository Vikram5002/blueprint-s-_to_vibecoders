/**
 * Minimal scripted JSON-RPC 2.0 client over stdio, for re-checking check_import
 * against a real repository without depending on the Inspector's --cli mode
 * (which hung indefinitely against a real download+run in this environment,
 * for reasons not diagnosed — see the Week 12 note in PHASE-1-SPEC.md).
 *
 * This is the "scripted client" tier docs/MCP.md distinguishes from the
 * Inspector: still real stdio, real JSON-RPC, a real spawned process running
 * the compiled server — just not an independently-authored host.
 *
 * Usage: node scripts/mcp-check.mjs <repo-path> <from> <to>
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'dist', 'cli.js');
const [, , target, from, to] = process.argv;

if (!target || !from || !to) {
  process.stderr.write('usage: node scripts/mcp-check.mjs <repo-path> <from> <to>\n');
  process.exit(2);
}

const child = spawn(process.execPath, [cliPath, target, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

child.stderr.on('data', (chunk) => process.stderr.write(`[server stderr] ${chunk}`));

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });
}

function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

try {
  const initResult = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vibe-blueprint-recheck', version: '0.0.0' },
  });
  console.log('initialize:', JSON.stringify(initResult.result ?? initResult.error));
  notify('notifications/initialized');

  const listResult = await call('tools/list');
  const toolNames = (listResult.result?.tools ?? []).map((t) => t.name);
  console.log('tools/list:', toolNames.join(', '));

  const checkResult = await call('tools/call', {
    name: 'check_import',
    arguments: { from, to },
  });
  console.log('check_import result:');
  console.log(JSON.stringify(checkResult.result ?? checkResult.error, null, 2));
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
