import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
} from 'electron';
import { ClipboardWatcher, type ClipboardSnapshot } from './clipboard-watcher.js';

/** A single clipboard entry as shown in the compact picker overlay. */
interface PickerItem {
  id: string;
  kind: 'text' | 'image';
  /** Truncated text, or an image data URL for image items. */
  preview: string;
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
      label: 'Paste on pick',
      type: 'checkbox',
      checked: pasteOnPick,
      click: (item) => {
        pasteOnPick = item.checked;
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
  const image = nativeImage.createFromPath(join(__dirname, '..', 'assets', 'icon.png'));
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
    setupPicker();
    setupGlobalShortcut();

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
