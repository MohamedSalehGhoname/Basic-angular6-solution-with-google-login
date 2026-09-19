import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  Tray,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
} from 'electron';
import { ClipboardWatcher, type ClipboardSnapshot } from './clipboard-watcher.js';
import { downloadFile, uploadFile } from './file-transfer.js';
import {
  filesFromArgv,
  registerContextMenu,
  sendToShortcut,
  unregisterContextMenu,
} from './shell-menu.js';

/** A file the user sent from Explorer, waiting for the renderer to upload it. */
interface FileSendRequest {
  requestId: string;
  name: string;
  sizeBytes: number;
}

/** A single clipboard entry as shown in the compact picker overlay. */
interface PickerItem {
  id: string;
  kind: 'text' | 'image';
  /** Truncated text, or an image data URL for image items. */
  preview: string;
}

/** The deployed web app, used when neither a dev URL nor a bundled build is set. */
const HOSTED_WEB_URL = 'https://ghoclipboard.ghonameservices.com';

/** Multi-size .ico on Windows (crisp in the tray and taskbar), PNG elsewhere. */
function appIcon(): string {
  return join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

const PICKER_WIDTH = 380;
const PICKER_HEIGHT = 480;

// Global shortcut that brings up the window on the clipboard list to pick from.
const PICKER_SHORTCUT = process.env['CLIPSYNC_HOTKEY'] ?? 'CommandOrControl+Shift+V';

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
// After a pick, place the item on the clipboard and send a paste keystroke to
// whatever app was focused before the overlay, like Ditto. Off via env var.
let pasteOnPick = process.env['CLIPSYNC_NO_AUTOPASTE'] ? false : true;
let mainWindow: BrowserWindow | null = null;
let pickerWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// Files sent from Explorer before the renderer was listening; handed over
// once it asks, then streamed live. Paths stay in the main process only.
let pendingFileSends: FileSendRequest[] = [];
const fileSendPaths = new Map<string, string>();
let rendererTakesFiles = false;

// Small per-install preferences the main process owns.
interface ShellSettings {
  explorerMenu: boolean;
}
const settingsPath = (): string => join(app.getPath('userData'), 'shell-settings.json');
function readShellSettings(): ShellSettings {
  try {
    return { explorerMenu: true, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { explorerMenu: true };
  }
}
function writeShellSettings(settings: ShellSettings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch {
    // Preference only.
  }
}

// Latest clipboard previews pushed by the (unlocked) main renderer. The picker
// overlay never decrypts anything itself — it just shows these previews and
// asks the main renderer to copy the chosen id, so it never needs the vault.
let pickerItems: PickerItem[] = [];

// Track image presence so a screenshot sitting on the clipboard is read (and
// base64-encoded) only when it first appears, not on every poll. Known limit:
// a direct image→image swap with no text in between is not re-captured.
let lastHadImage = false;

async function readClipboardImage(): Promise<string | null> {
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types?.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        if (blob instanceof Blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          return `data:${type};base64,${buffer.toString('base64')}`;
        }
      }
    }
  } catch {
    // Ignore; treat as no image.
  }
  return null;
}

async function readClipboard(): Promise<ClipboardSnapshot> {
  const text = await clipboard.readText();
  let image: string | null = null;
  if (text.trim().length === 0) {
    let hasImage = false;
    for (const type of ['image/png', 'image/jpeg', 'image/tiff']) {
      try {
        if (await clipboard.has(type)) {
          hasImage = true;
          break;
        }
      } catch {
        // Ignore probe failures.
      }
    }
    if (hasImage && !lastHadImage) {
      image = await readClipboardImage();
    }
    lastHadImage = hasImage;
  } else {
    lastHadImage = false;
  }

  const present = await Promise.all(
    EXCLUSION_MARKERS.map(async (marker) => {
      try {
        return (await clipboard.has(marker)) ? marker : null;
      } catch {
        return null;
      }
    }),
  );
  return { text, image, formats: present.filter((marker): marker is string => marker !== null) };
}

/**
 * The web app the window shows: a dev server when CLIPSYNC_WEB_URL is set,
 * otherwise the hosted one. The installed app loads it from the server
 * rather than from bundled files, so it is always the current version and
 * its origin (and so its saved access key and settings) matches the site.
 */
function resolveWebEntry(): string {
  return process.env['CLIPSYNC_WEB_URL'] || HOSTED_WEB_URL;
}

const RETRY_OFFLINE_MS = 10_000;

/** Shown when the web app cannot be reached; the window retries on its own. */
function offlinePage(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Clipboard Sync</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0f1216;color:#e6e8eb;
display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><h2>Clipboard Sync</h2><p>Can't reach the server. Check your internet connection.</p>
<p style="color:#8a929c">Trying again automatically…</p></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    show: true,
    icon: appIcon(),
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
    rendererTakesFiles = false;
  });
  // A reload drops the renderer's listeners until it asks for files again.
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      rendererTakesFiles = false;
    }
  });

  const entry = resolveWebEntry();
  let retry: NodeJS.Timeout | null = null;
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    // -3 is an aborted navigation (e.g. a redirect), not a failure.
    if (!isMainFrame || code === -3 || url.startsWith('data:')) {
      return;
    }
    void mainWindow?.loadURL(offlinePage());
    if (retry) {
      clearTimeout(retry);
    }
    retry = setTimeout(() => void mainWindow?.loadURL(entry), RETRY_OFFLINE_MS);
  });
  void mainWindow.loadURL(entry);
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
      label: 'Paste on pick',
      type: 'checkbox',
      checked: pasteOnPick,
      click: (item) => {
        pasteOnPick = item.checked;
      },
    },
    {
      label: 'Explorer "Send to" menu',
      type: 'checkbox',
      checked: readShellSettings().explorerMenu,
      visible: process.platform === 'win32',
      click: (item) => {
        writeShellSettings({ ...readShellSettings(), explorerMenu: item.checked });
        if (item.checked) {
          void registerExplorerMenu();
        } else {
          void unregisterExplorerMenu();
        }
      },
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
  const image = nativeImage.createFromPath(appIcon());
  tray = new Tray(image);
  tray.setToolTip('Clipboard Sync');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function createPickerWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: PICKER_WIDTH,
    height: PICKER_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  void win.loadFile(join(__dirname, '..', 'assets', 'picker.html'));
  // Dismiss like a native context menu when it loses focus.
  win.on('blur', () => win.hide());
  win.on('closed', () => {
    pickerWindow = null;
  });
  return win;
}

function positionPickerAtCursor(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x: ax, y: ay, width: aw, height: ah } = display.workArea;
  // Anchor near the cursor but keep the whole overlay on-screen.
  const x = Math.min(Math.max(cursor.x, ax), ax + aw - PICKER_WIDTH);
  const y = Math.min(Math.max(cursor.y, ay), ay + ah - PICKER_HEIGHT);
  win.setPosition(Math.round(x), Math.round(y));
}

function showPicker(): void {
  if (!pickerWindow) {
    pickerWindow = createPickerWindow();
  }
  const win = pickerWindow;
  const reveal = (): void => {
    positionPickerAtCursor(win);
    win.webContents.send('picker:items', pickerItems);
    win.show();
    win.focus();
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
}

function setupPicker(): void {
  // The main renderer pushes clipboard previews here whenever its list changes.
  ipcMain.on('clipsync:update-picker', (_event, items: PickerItem[]) => {
    pickerItems = Array.isArray(items) ? items : [];
    if (pickerWindow && pickerWindow.isVisible()) {
      pickerWindow.webContents.send('picker:items', pickerItems);
    }
  });
  // The overlay reports the chosen id; the main renderer copies it (reusing its
  // existing decrypt+copy path) and we dismiss the overlay.
  ipcMain.on('picker:pick', (_event, id: string) => {
    mainWindow?.webContents.send('clipsync:picker-copy', id);
    pickerWindow?.hide();
  });
  ipcMain.on('picker:close', () => pickerWindow?.hide());
  // Write to the OS clipboard from the main process: it needs no focused
  // document, unlike the renderer's Clipboard API, so a pick from the overlay
  // reliably lands on the clipboard even though the main window is hidden.
  ipcMain.on('clipsync:write-clipboard', (_event, payload: { text?: string; image?: string }) => {
    void writeToClipboard(payload);
  });
}

async function writeToClipboard(payload: {
  text?: string;
  image?: string;
  paste?: boolean;
}): Promise<void> {
  let wrote = false;
  try {
    if (payload?.image) {
      const match = /^data:(image\/[^;]+);base64,(.*)$/s.exec(payload.image);
      const mime = match?.[1];
      const base64 = match?.[2];
      if (mime && base64) {
        const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
        const blob = new Blob([bytes], { type: mime });
        await clipboard.write([new ClipboardItem({ [mime]: blob })]);
        wrote = true;
      }
    } else if (typeof payload?.text === 'string') {
      await clipboard.writeText(payload.text);
      wrote = true;
    }
  } catch {
    // Best-effort; nothing to surface from the main process.
  }
  if (wrote && payload?.paste && pasteOnPick) {
    // Give focus a moment to settle back on the previously-active window
    // (the overlay was already hidden) before sending the paste keystroke.
    setTimeout(pasteToActiveApp, 120);
  }
}

/**
 * Send a paste keystroke to the currently-focused application, so a picked item
 * lands directly where the user was typing. Uses each OS's built-in scripting
 * (no native module): SendKeys on Windows, System Events on macOS (needs
 * Accessibility permission), xdotool on Linux (if installed). Best-effort.
 */
function pasteToActiveApp(): void {
  try {
    if (process.platform === 'win32') {
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^v')",
        ],
        { windowsHide: true, stdio: 'ignore' },
      ).on('error', () => {});
    } else if (process.platform === 'darwin') {
      spawn(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { stdio: 'ignore' },
      ).on('error', () => {});
    } else {
      spawn('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { stdio: 'ignore' }).on(
        'error',
        () => {},
      );
    }
  } catch {
    // No scripting host available; the item is still on the clipboard.
  }
}

function setupGlobalShortcut(): void {
  try {
    globalShortcut.register(PICKER_SHORTCUT, showPicker);
  } catch {
    // The accelerator may be unavailable on this platform; ignore.
  }
}

function sendToLink() {
  return sendToShortcut(
    app.getPath('appData'),
    process.execPath,
    app.isPackaged ? null : app.getAppPath(),
  );
}

/** Adds "Send to ▸ Clipboard Sync" and the classic right-click entry. */
async function registerExplorerMenu(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const link = sendToLink();
  // 'create' also overwrites; 'replace' fails when the shortcut is missing.
  shell.writeShortcutLink(link.path, 'create', {
    target: link.target,
    args: link.args,
    icon: process.execPath,
    iconIndex: 0,
    description: 'Send to Clipboard Sync',
  });
  await registerContextMenu(process.execPath, app.isPackaged ? null : app.getAppPath());
}

async function unregisterExplorerMenu(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  rmSync(sendToLink().path, { force: true });
  await unregisterContextMenu();
}

/** Queues files sent from Explorer (or a second launch) for the renderer. */
async function receiveFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        continue;
      }
      const request: FileSendRequest = {
        requestId: randomUUID(),
        name: basename(path),
        sizeBytes: info.size,
      };
      fileSendPaths.set(request.requestId, path);
      if (rendererTakesFiles && mainWindow) {
        mainWindow.webContents.send('clipsync:file-send', request);
      } else {
        pendingFileSends.push(request);
      }
    } catch {
      // Vanished or unreadable; nothing to send.
    }
  }
}

function setupFileSharing(): void {
  if (readShellSettings().explorerMenu) {
    void registerExplorerMenu();
  }

  ipcMain.handle('clipsync:take-file-sends', () => {
    rendererTakesFiles = true;
    const pending = pendingFileSends;
    pendingFileSends = [];
    return pending;
  });

  // The renderer got a storage URL (and, when encrypting, a fresh per-file
  // key) from the sync server; stream the file there from disk.
  ipcMain.handle(
    'clipsync:upload-file',
    async (event, args: { requestId: string; uploadUrl: string; key: string | null }) => {
      const path = fileSendPaths.get(args.requestId);
      if (!path) {
        throw new Error('Unknown file');
      }
      try {
        await uploadFile(
          path,
          args.uploadUrl,
          args.key ? Buffer.from(args.key, 'base64') : null,
          (done, total) =>
            event.sender.send('clipsync:file-progress', { id: args.requestId, done, total }),
        );
      } finally {
        fileSendPaths.delete(args.requestId);
      }
    },
  );

  ipcMain.on('clipsync:forget-file', (_event, requestId: string) => {
    fileSendPaths.delete(requestId);
  });

  ipcMain.handle(
    'clipsync:download-file',
    async (
      event,
      args: { id: string; downloadUrl: string; name: string; key: string | null },
    ) => {
      const saved = await downloadFile(
        args.downloadUrl,
        app.getPath('downloads'),
        args.name,
        args.key ? Buffer.from(args.key, 'base64') : null,
        (done, total) => event.sender.send('clipsync:file-progress', { id: args.id, done, total }),
      );
      shell.showItemInFolder(saved);
      return saved;
    },
  );

  ipcMain.on('clipsync:show-window', showWindow);
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

// A development run keeps its own data folder (and single-instance lock), so
// it never collides with an installed "Clipboard Sync" on the same machine.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'clipsync-desktop'));
}

// A second launch focuses the existing window instead of starting again.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch focuses the existing window, unless it only carries files
  // sent from Explorer — those upload in the background.
  app.on('second-instance', (_event, argv) => {
    const files = filesFromArgv(argv);
    if (files.length > 0) {
      void receiveFiles(files);
    } else {
      showWindow();
    }
  });

  // Lets Windows attribute notifications and the taskbar to the installed app.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.ghonametech.ghoclipboard');
  }

  app.whenReady().then(() => {
    createWindow();
    setupTray();
    setupCapture();
    setupPicker();
    setupFileSharing();
    setupGlobalShortcut();
    void receiveFiles(filesFromArgv(process.argv));

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

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
