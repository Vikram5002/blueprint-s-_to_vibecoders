// Starts the bundled VibeCoder server for one folder and reports its address.
// Pure Node (no Electron API), so it can be tested on its own (test/).
//
// The server runs on this computer's own Node.js, not Electron's: VibeCoder
// needs Node and npm anyway to build the apps it generates, and its database
// driver (better-sqlite3) is a native module that must match the Node that
// loads it. So on first launch, and after an update, the bundled package is
// installed with this computer's npm into the app's data folder; later
// launches start straight away.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const MIN_NODE_MAJOR = 20;

/** "  Blueprint ready at  http://127.0.0.1:51234" -> the address. */
function parseReadyUrl(text) {
  const match = /ready at\s+(https?:\/\/[^\s]+)/.exec(text);
  return match ? match[1] : null;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { shell: IS_WINDOWS, windowsHide: true, ...options });
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: -1, output: String(error) }));
    child.on('exit', (code) => resolve({ code, output }));
  });
}

/** This computer's Node.js major version, or null when there is none. */
async function nodeMajor() {
  const { code, output } = await run('node', ['--version']);
  const match = /^v(\d+)\./.exec(output.trim());
  return code === 0 && match ? Number(match[1]) : null;
}

function quoteForShell(value) {
  return IS_WINDOWS ? `"${value}"` : value;
}

/**
 * Installs the bundled server package into `runtimeDir` unless that exact
 * version is already there. Returns the path of its CLI.
 */
async function ensureRuntime({ tarball, runtimeDir, onOutput = () => {} }) {
  const marker = path.join(runtimeDir, 'installed-from.txt');
  const stamp = `${path.basename(tarball)} ${fs.statSync(tarball).size}`;
  const cli = path.join(runtimeDir, 'node_modules', 'vibe-blueprint', 'dist', 'cli.js');
  if (fs.existsSync(cli) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return cli;

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'vibecoder-runtime', private: true }));
  onOutput('Setting up VibeCoder for the first time (about a minute)...\n');
  const { code, output } = await run(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', quoteForShell(runtimeDir), quoteForShell(tarball)],
    { cwd: runtimeDir },
  );
  onOutput(output);
  if (code !== 0 || !fs.existsSync(cli)) throw new Error(`setting up VibeCoder failed (npm exit code ${code}):\n${output.slice(-1500)}`);
  fs.writeFileSync(marker, stamp);
  return cli;
}

/** Starts `node <cli> <folder> --no-open`; returns { ready, stop, child }. */
function startServer({ cli, folder, timeoutMs = 3 * 60_000, onOutput = () => {} }) {
  const child = spawn('node', [cli, folder, '--no-open'], { cwd: folder, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  const stop = () => {
    if (child.exitCode === null && !child.killed) child.kill();
  };
  const ready = new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`VibeCoder did not start within ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      onOutput(text);
      seen += text;
      const url = parseReadyUrl(seen);
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    child.stderr.on('data', (chunk) => onOutput(chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`VibeCoder stopped while starting (exit code ${code}).\n${seen.split('\n').slice(-6).join('\n')}`));
    });
  });
  return { ready, stop, child };
}

module.exports = { MIN_NODE_MAJOR, parseReadyUrl, nodeMajor, ensureRuntime, startServer };
