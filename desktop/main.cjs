// VibeCoder desktop: a window around the same server and UI as `npx vibe-blueprint`.
// No logic of its own - it picks a folder, starts the bundled server for it,
// and shows the workspace page.
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MIN_NODE_MAJOR, ensureRuntime, nodeMajor, startServer } = require('./server-runner.cjs');

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
const log = [];

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
  win.setTitle(`VibeCoder - ${folder}`);
  await win.loadURL(loadingPage(`Opening ${folder.replace(/[<>&]/g, '')}…`));
  try {
    cli ??= await ensureRuntime({
      tarball: bundledTarball(),
      runtimeDir: path.join(app.getPath('userData'), 'runtime'),
      onOutput: (text) => log.push(text),
    });
    server = startServer({ cli, folder, onOutput: (text) => log.push(text) });
    const url = await server.ready;
    writeSettings({ ...readSettings(), folder });
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
  await open(defaultFolder());
});

app.on('window-all-closed', () => {
  server?.stop();
  app.quit();
});

app.on('before-quit', () => server?.stop());
