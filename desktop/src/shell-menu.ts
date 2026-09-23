import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

/** Command-line switch Explorer passes a right-clicked file with. */
export const SEND_FILE_FLAG = '--send-file';
/** "Send to" appends every selected file after the shortcut's arguments. */
export const SEND_FILES_FLAG = '--send-files';

const MENU_KEY = 'HKCU\\Software\\Classes\\*\\shell\\ClipSync';
const MENU_LABEL = 'Send to Clipboard Sync';

/**
 * File paths on a command line: the one after each SEND_FILE_FLAG, and
 * everything after SEND_FILES_FLAG. Switches Chromium adds to a relaunch
 * start with "--" and are skipped; a file path never does.
 */
export function filesFromArgv(argv: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === SEND_FILE_FLAG && argv[i + 1]) {
      files.push(argv[i + 1]!);
      i += 1;
    } else if (argv[i] === SEND_FILES_FLAG) {
      files.push(...argv.slice(i + 1).filter((arg) => arg && !arg.startsWith('--')));
      break;
    }
  }
  return files;
}

/**
 * The `reg add` calls that put "Send to Clipboard Sync" on every file's
 * right-click menu for the current user (no admin needed). A packaged app
 * is launched as its own exe; in development the Electron binary needs the
 * app folder too. Windows 11's new menu hides these classic entries (they
 * show under "Show more options"), so see sendToShortcut() too.
 */
export function contextMenuCommands(execPath: string, appPath: string | null): string[][] {
  const launcher = appPath ? `"${execPath}" "${appPath}"` : `"${execPath}"`;
  return [
    ['add', MENU_KEY, '/ve', '/d', MENU_LABEL, '/f'],
    ['add', MENU_KEY, '/v', 'Icon', '/d', `"${execPath}",0`, '/f'],
    ['add', `${MENU_KEY}\\command`, '/ve', '/d', `${launcher} ${SEND_FILE_FLAG} "%1"`, '/f'],
  ];
}

/** Registers (or refreshes) the Explorer entry. Windows only; best-effort. */
export async function registerContextMenu(execPath: string, appPath: string | null): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  for (const args of contextMenuCommands(execPath, appPath)) {
    await new Promise<void>((resolve) => {
      execFile('reg.exe', args, { windowsHide: true }, () => resolve());
    });
  }
}

export async function unregisterContextMenu(): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  await new Promise<void>((resolve) => {
    execFile('reg.exe', ['delete', MENU_KEY, '/f'], { windowsHide: true }, () => resolve());
  });
}

/**
 * The "Send to ▸ Clipboard Sync" shortcut, which Windows 11's new menu does
 * show, and which passes every selected file in one launch.
 */
export function sendToShortcut(
  appDataDir: string,
  execPath: string,
  appPath: string | null,
): { path: string; target: string; args: string } {
  return {
    path: win32.join(appDataDir, 'Microsoft', 'Windows', 'SendTo', 'Clipboard Sync.lnk'),
    target: execPath,
    args: appPath ? `"${appPath}" ${SEND_FILES_FLAG}` : SEND_FILES_FLAG,
  };
}
