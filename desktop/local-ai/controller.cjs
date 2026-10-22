const fs = require('node:fs');
const path = require('node:path');
const { detect, GiB } = require('./hardware.cjs');
const { download, verified } = require('./files.cjs');

/** Every base-model file once, even when several adapters share a base. */
function uniqueFiles(models) {
  return [...new Map(models.flatMap((m) => m.files).map((f) => [f.name, f])).values()];
}
const { Engine } = require('./engine.cjs');
const { startBridge } = require('./bridge.cjs');

class LocalAI {
  constructor({ assets, defaultFolder, readSettings, writeSettings, onChange = () => {}, createEngine = (options) => new Engine(options) }) {
    Object.assign(this, { assets, readSettings, writeSettings, onChange, createEngine });
    this.manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
    this.executable = path.join(assets, 'runtime', 'llama-server.exe');
    this.folder = readSettings().localAI?.folder ?? defaultFolder;
    this.state = { busy: false, message: 'Check this computer to get started.', enabled: false, folder: this.folder, models: this.manifest.models.map((m) => m.label), downloadGB: uniqueFiles(this.manifest.models).reduce((sum, f) => sum + f.bytes, 0) / 1e9 };
  }

  update(values) { Object.assign(this.state, values); this.onChange(this.state); }

  async inspect() {
    const ancestor = fs.existsSync(this.folder) ? this.folder : path.dirname(this.folder);
    const hardware = await detect(this.executable, ancestor);
    this.update({ hardware });
    return this.state;
  }

  setFolder(folder) {
    if (this.state.busy || this.state.enabled) throw new Error('Stop local AI before changing its folder.');
    this.folder = folder;
    this.writeSettings({ ...this.readSettings(), localAI: { ...this.readSettings().localAI, folder, enabled: false } });
    this.update({ folder });
    return this.inspect();
  }

  cancel() { this.abort?.abort(new Error('Setup cancelled. Partial downloads are kept for resume.')); }

  stop() {
    this.cancel();
    this.bridge?.stop();
    this.bridge = null;
    this.engine?.stop();
    this.update({ enabled: false, message: 'Local AI is stopped. Model files are kept.' });
  }

  async setup({ mode = 'auto', importOnly = false, testModels = true, onReady = async () => {} } = {}) {
    if (this.state.busy) throw new Error('Local setup is already running.');
    if (!['auto', 'cpu', 'gpu', 'hybrid'].includes(mode)) throw new Error('Invalid compute mode');
    this.bridge?.stop();
    this.bridge = null;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.update({ busy: true, enabled: false, error: null, progress: null, message: 'Checking this computer...' });
    try {
      await this.inspect();
      const hardware = this.state.hardware;
      const recommended = hardware.recommendation;
      if (!recommended.supported) throw new Error(recommended.reason);
      const selected = mode === 'auto' ? recommended.mode : mode;
      if (selected !== 'cpu' && !recommended.device) throw new Error('No compatible dedicated GPU was detected. Select CPU mode.');
      fs.mkdirSync(this.folder, { recursive: true });
      const files = uniqueFiles(this.manifest.models);
      const remaining = files.reduce((sum, file) => {
        const final = path.join(this.folder, file.name);
        const part = final + '.part';
        const have = fs.existsSync(final) ? fs.statSync(final).size : fs.existsSync(part) ? fs.statSync(part).size : 0;
        return sum + Math.max(0, file.bytes - have);
      }, 0);
      const disk = fs.statfsSync(this.folder);
      if (disk.bavail * disk.bsize < remaining + GiB) throw new Error(`Not enough disk space. Keep at least ${(remaining / GiB + 1).toFixed(1)} GB free in the selected folder.`);
      const ready = new Set();
      for (const model of this.manifest.models) {
        this.update({ progress: null, message: `Verifying bundled ${model.label} adapter...` });
        if (!await verified(path.join(this.assets, model.adapterFile), { sha256: model.adapterSha256 }, signal)) throw new Error('Bundled adapter checksum failed. Reinstall VibeCoder.');
        for (const file of model.files) {
          // Models on one base share its files: check or download each once.
          if (ready.has(file.name)) continue;
          ready.add(file.name);
          if (importOnly) {
            this.update({ message: `Checking ${file.name}...` });
            if (!await verified(path.join(this.folder, file.name), file, signal)) throw new Error(`Missing or incorrect file: ${file.name}. Select the folder containing the official Q4_K_M files, or use Download / resume.`);
          } else {
            let lastProgress = 0;
            await download(file, this.folder, { signal, onProgress: (progress) => {
              if (Date.now() - lastProgress > 200 || progress.phase !== 'Downloading') {
                lastProgress = Date.now();
                this.update({ progress, message: `${progress.phase}: ${progress.file}` });
              }
            } });
          }
        }
      }
      this.update({ progress: null });
      this.engine = this.createEngine({ executable: this.executable, assets: this.assets, folder: this.folder, mode: selected, device: recommended.device, models: this.manifest.models, onStatus: (message) => this.update({ message }) });
      for (const model of testModels ? this.manifest.models : []) {
        const result = await this.engine.complete({ model: model.id, system: 'You are a helpful assistant.', user: 'Reply with the word ready.', maxOutputTokens: 8 }, AbortSignal.any([signal, AbortSignal.timeout(180_000)]));
        if (!result.ok && result.error.kind !== 'incomplete') throw new Error(`Model check failed: ${result.error.message}`);
      }
      signal.throwIfAborted();
      await this.engine.unload();
      this.bridge = await startBridge(this.engine, this.manifest.models);
      signal.throwIfAborted();
      await onReady();
      signal.throwIfAborted();
      this.writeSettings({ ...this.readSettings(), localAI: { enabled: true, folder: this.folder, mode }, localAISeen: true });
      this.update({ enabled: true, mode: selected, progress: null, message: `Local AI is ready in ${selected} mode. Models load when needed and unload after five idle minutes.` });
      return this.bridge.url;
    } catch (error) {
      this.engine?.stop();
      this.bridge?.stop();
      this.bridge = null;
      this.update({ enabled: false, error: error.message, message: `${error.message}${mode !== 'cpu' ? ' If GPU loading failed, try CPU mode.' : ''}` });
      throw error;
    } finally { this.update({ busy: false }); }
  }
}

module.exports = { LocalAI };
