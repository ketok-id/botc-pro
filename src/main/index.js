// Electron main process.
// Boots the desktop app, optionally spawns an embedded BOTC server,
// and wires IPC between the renderer and the networking layer.

const { app, BrowserWindow, ipcMain, dialog, session, shell, systemPreferences } = require('electron');
const path = require('path');
const os = require('os');
const { startServer, stopServer } = require('./server');

let mainWindow = null;
let embeddedServer = null;

// Allow microphone access for voice chat. We gate this to the main window's
// origin (file://). If you later serve renderer assets from a remote URL,
// narrow this to that origin.
function wireMediaPermissions() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      return cb(true);
    }
    cb(false);
  });
  // Some Chromium builds route mic through a separate "check" handler:
  s.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'audioCapture' || permission === 'microphone';
  });
}

// OS-level microphone permission. Chromium's permission handlers above only
// cover the renderer layer — Windows 10/11 and macOS also gate mic access at
// the OS privacy settings, and if the user previously denied it there, the
// browser-side `allow` is meaningless.
function getMicAccessStatus() {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try { return systemPreferences.getMediaAccessStatus('microphone'); }
    catch { return 'unknown'; }
  }
  return 'granted';
}

function openOsMicSettings() {
  if (process.platform === 'win32') {
    return shell.openExternal('ms-settings:privacy-microphone');
  }
  if (process.platform === 'darwin') {
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  }
  return Promise.resolve();
}

async function ensureMicOnStartup() {
  // macOS: the OS shows its own prompt the first time we ask.
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }
  const status = getMicAccessStatus();
  if (status === 'denied' || status === 'restricted') {
    const openLabel = process.platform === 'win32' ? 'Open Windows Settings' : 'Open System Settings';
    const res = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Microphone access blocked',
      message: 'BOTC Pro can’t access your microphone.',
      detail:
        process.platform === 'win32'
          ? 'Windows is blocking microphone access for this app. Open Settings → Privacy & security → Microphone and make sure "Microphone access" and "Let desktop apps access your microphone" are both turned on. You can also reach this from the in-app Settings panel.'
          : 'The OS is blocking microphone access. Enable it in System Settings → Privacy & Security → Microphone.',
      buttons: [openLabel, 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (res.response === 0) openOsMicSettings();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'BOTC Pro',
    backgroundColor: '#0b0a14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  wireMediaPermissions();
  createWindow();
  // Fire-and-forget: we don't want to block the window from loading.
  ensureMicOnStartup().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (embeddedServer) {
    try { await stopServer(embeddedServer); } catch (_) {}
    embeddedServer = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC API ----

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  hostname: os.hostname(),
  interfaces: listLanAddresses(),
}));

ipcMain.handle('server:start', async (_event, opts) => {
  if (embeddedServer) {
    return { ok: true, already: true, port: embeddedServer.port, lan: listLanAddresses() };
  }
  try {
    embeddedServer = await startServer({
      port: opts?.port ?? 0,
      bind: opts?.bind ?? '0.0.0.0',
      // Serving the renderer over HTTP lets LAN guests join from a plain
      // browser (http://<host-ip>:<port>/) without installing anything, while
      // the Storyteller keeps using the desktop app.
      webRoot: path.join(__dirname, '..', 'renderer'),
    });
    return { ok: true, port: embeddedServer.port, lan: listLanAddresses() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:stop', async () => {
  if (!embeddedServer) return { ok: true };
  try {
    await stopServer(embeddedServer);
    embeddedServer = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server:status', () => ({
  running: !!embeddedServer,
  port: embeddedServer?.port ?? null,
  lan: listLanAddresses(),
}));

ipcMain.handle('dialog:error', (_e, msg) => {
  if (!mainWindow) return;
  dialog.showErrorBox('BOTC Pro', String(msg));
});

ipcMain.handle('mic:status', () => ({
  platform: process.platform,
  status: getMicAccessStatus(),
}));

ipcMain.handle('mic:ask', async () => {
  if (process.platform === 'darwin') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { granted, status: getMicAccessStatus() };
    } catch (err) {
      return { granted: false, status: getMicAccessStatus(), error: err.message };
    }
  }
  // Windows/Linux: no programmatic prompt. Caller should open settings instead.
  return { granted: getMicAccessStatus() === 'granted', status: getMicAccessStatus() };
});

ipcMain.handle('mic:open-settings', async () => {
  await openOsMicSettings();
  return { ok: true };
});

function listLanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        out.push({ iface: name, address: net.address });
      }
    }
  }
  return out;
}
