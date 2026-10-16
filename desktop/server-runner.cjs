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
const nodeExecutablesByCli = new Map();

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
    child.on('close', (code) => resolve({ code, output }));
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

/** Ask the Node executable that runs the server, rather than Electron's Node. */
async function nodeRuntime() {
  const expression = 'JSON.stringify({execPath:process.execPath,version:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})';
  const { code, output } = await run('node', ['-p', quoteForShell(expression)]);
  try {
    const runtime = JSON.parse(output.trim());
    if (code === 0 && runtime !== null && ['execPath', 'version', 'modules', 'platform', 'arch'].every((key) => typeof runtime[key] === 'string')) return runtime;
  } catch {
    // An absent or unusable system Node cannot produce a compatible runtime.
  }
  throw new Error('could not identify this computer\'s Node.js runtime - install Node.js and open VibeCoder again');
}

/**
 * Installs the bundled server package into `runtimeDir` unless that exact
 * version and system Node runtime are already there. Returns the path of its CLI.
 */
async function ensureRuntime({ tarball, runtimeDir, onOutput = () => {} }) {
  const node = await nodeRuntime();
  const marker = path.join(runtimeDir, 'installed-from.txt');
  const stamp = JSON.stringify({ tarball: `${path.basename(tarball)} ${fs.statSync(tarball).size}`, node });
  const cli = path.join(runtimeDir, 'node_modules', 'vibe-blueprint', 'dist', 'cli.js');
  if (fs.existsSync(cli) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) {
    nodeExecutablesByCli.set(cli, node.execPath);
    return cli;
  }

  const hadInstalledPackages = fs.existsSync(path.join(runtimeDir, 'node_modules'));
  fs.mkdirSync(runtimeDir, { recursive: true });
  // A failed reinstall must not leave a marker that can approve a partial tree.
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'vibecoder-runtime', private: true }));
  onOutput('Setting up VibeCoder for the first time (about a minute)...\n');
  const installOptions = {
    cwd: runtimeDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, npm_config_runtime: 'node', npm_config_target: node.version.slice(1), npm_config_arch: node.arch },
  };
  const { code, output } = await run(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', quoteForShell(runtimeDir), quoteForShell(tarball)],
    installOptions,
  );
  onOutput(output);
  if (code !== 0 || !fs.existsSync(cli)) throw new Error(`setting up VibeCoder failed (npm exit code ${code}):\n${output.slice(-1500)}`);
  if (hadInstalledPackages) {
    // npm install can keep an unchanged package's binary from the previous ABI.
    onOutput('Updating the database driver for this computer\'s Node.js...\n');
    const rebuilt = await run('npm', ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'], installOptions);
    onOutput(rebuilt.output);
    if (rebuilt.code !== 0) throw new Error(`updating the database driver failed (npm exit code ${rebuilt.code}):\n${rebuilt.output.slice(-1500)}`);
  }
  fs.writeFileSync(marker, stamp);
  nodeExecutablesByCli.set(cli, node.execPath);
  return cli;
}

/** Starts `node <cli> <folder> --no-open`; returns { ready, stop, child }. */
function startServer({ cli, folder, timeoutMs = 3 * 60_000, onOutput = () => {} }) {
  const child = spawn(nodeExecutablesByCli.get(cli) ?? 'node', [cli, folder, '--no-open'], { cwd: folder, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
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
