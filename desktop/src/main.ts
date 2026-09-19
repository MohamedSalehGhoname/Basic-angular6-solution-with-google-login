import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, app, clipboard, ipcMain } from 'electron';
import { ClipboardWatcher, type ClipboardSnapshot } from './clipboard-watcher.js';

// Clipboard formats/types apps set to ask that a value not be recorded; probed
// via the async clipboard API since it exposes has() rather than a format list.
const EXCLUSION_MARKERS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'CanIncludeInClipboardHistory',
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
];

async function readClipboard(): Promise<ClipboardSnapshot> {
  const text = await clipboard.readText();
  const present = await Promise.all(
    EXCLUSION_MARKERS.map(async (marker) => {
      try {
        return (await clipboard.has(marker)) ? marker : null;
      } catch {
        return null;
      }
    }),
  );
  return { text, formats: present.filter((marker): marker is string => marker !== null) };
}

// Renderer-driven capture settings; the renderer persists the user's choice
// and pushes it here on startup and on every toggle.
let captureEnabled = false;
let captureSecrets = false;
let mainWindow: BrowserWindow | null = null;

function resolveWebEntry(): string | null {
  // Dev: point at the Angular dev server. Prod: the built web app copied in.
  const devUrl = process.env['CLIPSYNC_WEB_URL'];
  if (devUrl) {
    return devUrl;
  }
  const packaged = join(__dirname, '..', 'web', 'index.html');
  return existsSync(packaged) ? packaged : null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 720,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const entry = resolveWebEntry();
  if (!entry) {
    mainWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<h1>Clipboard Sync</h1><p>Set CLIPSYNC_WEB_URL to the web app ' +
            '(e.g. http://localhost:4200) or bundle the built web app.</p>',
        ),
    );
    return;
  }
  if (entry.startsWith('http')) {
    void mainWindow.loadURL(entry);
  } else {
    void mainWindow.loadFile(entry);
  }
}

function setupCapture(): void {
  const watcher = new ClipboardWatcher({
    read: readClipboard,
    isEnabled: () => captureEnabled,
    captureSecrets: () => captureSecrets,
    onCapture: (captured) => {
      mainWindow?.webContents.send('clipsync:captured', captured);
    },
  });
  watcher.start();

  ipcMain.on('clipsync:set-enabled', (_event, enabled: boolean) => {
    captureEnabled = Boolean(enabled);
  });
  ipcMain.on('clipsync:set-capture-secrets', (_event, enabled: boolean) => {
    captureSecrets = Boolean(enabled);
  });
}

app.whenReady().then(() => {
  createWindow();
  setupCapture();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
