import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, clipboard, ipcMain, nativeImage } from 'electron';
import { ClipboardWatcher, type ClipboardSnapshot } from './clipboard-watcher.js';

// Clipboard formats/types apps set to ask that a value not be recorded; probed
// via the async clipboard API since it exposes has() rather than a format list.
const EXCLUSION_MARKERS = [
  'ExcludeClipboardContentFromMonitorProcessing',
  'CanIncludeInClipboardHistory',
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
];

// Renderer-driven capture settings; the renderer persists the user's choice
// and pushes it here on startup and on every toggle.
let captureEnabled = false;
let captureSecrets = false;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

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

function resolveWebEntry(): string | null {
  // Dev: point at the Angular dev server. Prod: the built web app bundled in.
  const devUrl = process.env['CLIPSYNC_WEB_URL'];
  if (devUrl) {
    return devUrl;
  }
  const packaged = join(__dirname, '..', 'web', 'index.html');
  return existsSync(packaged) ? packaged : null;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    show: true,
    icon: join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Closing hides the window to the tray so capture keeps running in the
  // background; the tray's Quit actually exits.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const entry = resolveWebEntry();
  if (!entry) {
    void mainWindow.loadURL(
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

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Clipboard Sync', click: showWindow },
    {
      label: 'Capture copies',
      type: 'checkbox',
      checked: captureEnabled,
      // The renderer owns the setting; ask it to toggle so its UI stays in sync.
      click: () => mainWindow?.webContents.send('clipsync:request-toggle-capture'),
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

function setupTray(): void {
  const image = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'icon.png'));
  tray = new Tray(image);
  tray.setToolTip('Clipboard Sync');
  tray.on('click', showWindow);
  refreshTrayMenu();
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
    refreshTrayMenu();
  });
  ipcMain.on('clipsync:set-capture-secrets', (_event, enabled: boolean) => {
    captureSecrets = Boolean(enabled);
  });
}

// A second launch focuses the existing window instead of starting again.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    createWindow();
    setupTray();
    setupCapture();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        showWindow();
      }
    });
  });

  // Keep running in the tray when all windows are closed (needed for capture).
  app.on('window-all-closed', () => {
    // Intentionally do not quit; the tray keeps the app alive.
  });

  app.on('before-quit', () => {
    quitting = true;
  });
}
