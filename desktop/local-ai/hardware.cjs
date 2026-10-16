const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const GiB = 1024 ** 3;

function recommendation({ platform, arch, ramGB, devices, runtimeOK }) {
  if (platform !== 'win32' || arch !== 'x64') return { supported: false, mode: 'cpu', reason: 'This installer supports 64-bit Windows on Intel/AMD processors.' };
  if (!runtimeOK) return { supported: false, mode: 'cpu', reason: 'The local runtime could not run. Update Windows and graphics drivers, then recheck.' };
  if (ramGB < 15) return { supported: false, mode: 'cpu', reason: 'These 7B models require at least 16 GB installed RAM. You can continue using an online provider.' };
  const best = devices.filter((d) => d.shared === false).sort((a, b) => b.memoryMB - a.memoryMB)[0];
  if (best?.memoryMB >= 7500) return { supported: true, mode: 'gpu', device: best.id, layers: 99, reason: 'GPU acceleration recommended. Model loading will verify available memory.' };
  if (best?.memoryMB >= 3500) return { supported: true, mode: 'hybrid', device: best.id, layers: 12, reason: 'Use the GPU for part of the model, with the rest in system RAM.' };
  return { supported: true, mode: 'cpu', layers: 0, reason: 'CPU mode is available. Planning and code generation may take several minutes.' };
}

function parseDevices(output) {
  const kinds = new Map([...output.matchAll(/ggml_vulkan:\s*(\d+) = .*?\| uma: ([01])/g)].map((m) => [`Vulkan${m[1]}`, m[2] === '1']));
  return [...output.matchAll(/^\s*(Vulkan\d+):\s*(.+?)\s*\((\d+)\s*MiB(?:,.*?)?\)\s*$/gm)]
    .map((match) => ({ id: match[1], name: match[2], memoryMB: Number(match[3]), shared: kinds.get(match[1]) ?? null }));
}

async function detect(executable, folder) {
  const cpus = os.cpus();
  let runtimeOK = false;
  let devices = [];
  let probeError = '';
  try {
    const result = await execute(executable, ['--log-verbosity', '5', '--list-devices'], { windowsHide: true, timeout: 30_000, maxBuffer: 512 * 1024 });
    runtimeOK = true;
    devices = parseDevices(result.stdout + '\n' + result.stderr);
  } catch (error) { probeError = error.message.slice(0, 500); }
  let freeGB = null;
  try { const disk = fs.statfsSync(folder); freeGB = disk.bavail * disk.bsize / GiB; } catch { /* The folder picker can choose a new location. */ }
  const facts = { platform: os.platform(), arch: os.arch(), cpu: cpus[0]?.model ?? 'Unknown CPU', threads: cpus.length, ramGB: os.totalmem() / GiB, availableGB: os.freemem() / GiB, freeGB, devices, runtimeOK, probeError };
  return { ...facts, recommendation: recommendation(facts) };
}

module.exports = { detect, recommendation, parseDevices, GiB };
