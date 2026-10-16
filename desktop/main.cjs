// VibeCoder desktop: a window around the same server and UI as `npx vibe-blueprint`.
// The optional local-AI runtime lives in local-ai/; workspace logic stays in the server.
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MIN_NODE_MAJOR, ensureRuntime, nodeMajor, startServer } = require('./server-runner.cjs');
const { LocalAI } = require('./local-ai/controller.cjs');
const { connection, restoration } = require('./local-ai/workspace.cjs');

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

/** The folder VibeCoder works in: the last one opened, or a fresh "VibeCoder Projects" folder. */
function defaultFolder() {
  const last = readSettings().folder;
  if (last && fs.existsSync(last)) return last;
  const fresh = path.join(app.getPath('documents'), 'VibeCoder Projects');
  fs.mkdirSync(fresh, { recursive: true });
  return fresh;
}

let win = null;
let server = null;
let cli = null;
let workspaceUrl = null;
let localAI = null;
let setupWindow = null;
const log = [];

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function localAssets() {
  const installed = path.join(process.resourcesPath, 'local-ai');
  return fs.existsSync(installed) ? installed : path.join(__dirname, 'vendor', 'local-ai');
}

async function useLocalProvider(folder, activate = false) {
  if (!workspaceUrl || !localAI.bridge) return;
  const endpoint = `${workspaceUrl}/api/providers`;
  const settings = readSettings();
  const previous = settings.previousProviders ?? {};
  const read = await fetch(endpoint);
  if (!read.ok) throw new Error('Could not read workspace model settings.');
  const { saved, body } = connection(await read.json(), previous[folder], localAI.bridge.url, activate);
  previous[folder] = saved;
  writeSettings({ ...settings, previousProviders: previous });
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Could not connect the workspace to local AI.');
}

async function restoreProvider(folder) {
  const settings = readSettings();
  const previous = settings.previousProviders ?? {};
  const saved = previous[folder];
  if (workspaceUrl && saved) {
    const response = await fetch(`${workspaceUrl}/api/providers`);
    const current = await response.json();
    const body = restoration(current, saved);
    if (Object.keys(body).length) {
      const restored = await fetch(`${workspaceUrl}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!restored.ok) throw new Error('Local AI stopped. Choose your provider in the workspace.');
    }
    delete previous[folder];
  }
  writeSettings({ ...readSettings(), previousProviders: previous });
}

async function disableLocal() {
  localAI.stop();
  writeSettings({ ...readSettings(), localAI: { ...readSettings().localAI, enabled: false }, localAISeen: true });
  await restoreProvider(readSettings().folder);
}

function showLocalSetup() {
  if (setupWindow) { setupWindow.focus(); return Promise.resolve(); }
  setupWindow = new BrowserWindow({ width: 930, height: 900, minWidth: 780, minHeight: 680, parent: win, modal: true, autoHideMenuBar: true, backgroundColor: '#101418',
    webPreferences: { preload: path.join(__dirname, 'local-ai', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  setupWindow.on('close', () => localAI.cancel());
  void setupWindow.loadFile(path.join(__dirname, 'local-ai', 'setup.html'));
  return new Promise((resolve) => setupWindow.once('closed', () => { setupWindow = null; resolve(); }));
}

ipcMain.handle('local-ai', async (event, action, options) => {
  const expected = pathToFileURL(path.join(__dirname, 'local-ai', 'setup.html')).href;
  if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame !== setupWindow.webContents.mainFrame || event.senderFrame.url !== expected) throw new Error('Invalid setup sender');
  try {
    if (action === 'state') return localAI.state;
    if (action === 'check') return await localAI.inspect();
    if (action === 'folder') {
      const picked = await dialog.showOpenDialog(setupWindow, { title: 'Choose the model folder', defaultPath: localAI.folder, properties: ['openDirectory', 'createDirectory'] });
      if (!picked.canceled && picked.filePaths[0]) await localAI.setFolder(picked.filePaths[0]);
    } else if (action === 'setup') {
      if (typeof options?.importOnly !== 'boolean') throw new Error('Invalid setup options');
      await localAI.setup({ mode: options.mode, importOnly: options.importOnly,
        onReady: async () => { if (workspaceUrl) await useLocalProvider(readSettings().folder, true); } });
    } else if (action === 'cancel') localAI.cancel();
    else if (action === 'stop') {
      localAI.update({ busy: true });
      try { await disableLocal(); } finally { localAI.update({ busy: false }); }
    }
    else if (action === 'continue') {
      if (localAI.state.busy) throw new Error('Wait for setup or cancel it first.');
      writeSettings({ ...readSettings(), localAISeen: true, localAI: { ...readSettings().localAI, enabled: localAI.state.enabled } });
      setupWindow.close();
      if (workspaceUrl) await win.reload();
    }
    return { ok: true };
  } catch (error) { return { error: error.message }; }
});

/** The bundled server package: next to the app when installed, in vendor/ when run from source. */
function bundledTarball() {
  const installed = path.join(process.resourcesPath, 'vibe-blueprint.tgz');
  if (fs.existsSync(installed)) return installed;
  const fromSource = fs.readdirSync(path.join(__dirname, 'vendor')).find((name) => name.endsWith('.tgz'));
  return path.join(__dirname, 'vendor', fromSource);
}

function loadingPage(message) {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0c0c0e;color:#e5e5ea;font:15px system-ui,'Segoe UI',sans-serif"><div style="text-align:center"><div style="font-size:20px;font-weight:600;margin-bottom:8px">VibeCoder</div><div style="color:#a1a1aa">${message}</div></div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function open(folder) {
  server?.stop();
  workspaceUrl = null;
  win.setTitle(`VibeCoder - ${folder}`);
  await win.loadURL(loadingPage(`Opening ${folder.replace(/[<>&]/g, '')}…`));
  try {
    cli = await ensureRuntime({
      tarball: bundledTarball(),
      runtimeDir: path.join(app.getPath('userData'), 'runtime'),
      onOutput: (text) => log.push(text),
    });
    server = startServer({ cli, folder, onOutput: (text) => log.push(text) });
    const url = await server.ready;
    workspaceUrl = url;
    writeSettings({ ...readSettings(), folder });
    if (localAI?.state.enabled) await useLocalProvider(folder);
    else await restoreProvider(folder);
    await win.loadURL(`${url}/workspace.html`);
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'VibeCoder could not start',
      message: 'VibeCoder could not start for this folder.',
      detail: `${error.message}\n\n${log.slice(-10).join('')}`,
    });
  }
}

async function chooseFolder() {
  const picked = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] });
  if (!picked.canceled && picked.filePaths[0]) await open(picked.filePaths[0]);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void chooseFolder() },
          { label: 'Show Folder', click: () => void shell.openPath(readSettings().folder ?? defaultFolder()) },
          { label: 'Local AI Setup...', click: () => void showLocalSetup() },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      {
        label: 'Help',
        submenu: [{ label: 'Get Node.js (needed to build generated apps)', click: () => void shell.openExternal('https://nodejs.org/') }],
      },
    ]),
  );
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0c0e',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Links to other sites open in the normal browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  buildMenu();

  try {
    localAI = new LocalAI({ assets: localAssets(), defaultFolder: path.join(app.getPath('userData'), 'models'), readSettings, writeSettings,
      onChange: (state) => { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('local-ai-state', state); } });
  } catch (error) {
    await dialog.showMessageBox(win, { type: 'error', message: 'The local AI bundle is missing or damaged.', detail: `${error.message}\nRun npm run prepare:local before starting from source, or reinstall VibeCoder.` });
    app.quit();
    return;
  }

  const major = await nodeMajor();
  if (major === null || major < MIN_NODE_MAJOR) {
    await win.loadURL(loadingPage(`VibeCoder needs Node.js ${MIN_NODE_MAJOR} or newer.`));
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Node.js is needed',
      message: major === null ? 'VibeCoder needs Node.js, which is not installed.' : `VibeCoder needs Node.js ${MIN_NODE_MAJOR} or newer (this computer has ${major}).`,
      detail: 'VibeCoder runs on Node.js and uses npm to build every app it generates. Install the LTS version from nodejs.org, then open VibeCoder again.',
      buttons: ['Get Node.js', 'Close'],
    });
    if (response === 0) await shell.openExternal('https://nodejs.org/');
    app.quit();
    return;
  }
  const settings = readSettings();
  if (settings.localAI?.enabled) {
    await win.loadURL(loadingPage('Checking local model files...'));
    try { await localAI.setup({ mode: settings.localAI.mode, importOnly: true, testModels: false }); }
    catch { await showLocalSetup(); }
  } else if (!settings.localAISeen) {
    await win.loadURL(loadingPage('Choose how to run your models in Local AI setup.'));
    await showLocalSetup();
  }
  if (!win.isDestroyed()) await open(defaultFolder());
});

app.on('window-all-closed', () => {
  server?.stop();
  app.quit();
});

app.on('before-quit', () => { server?.stop(); localAI?.stop(); });
