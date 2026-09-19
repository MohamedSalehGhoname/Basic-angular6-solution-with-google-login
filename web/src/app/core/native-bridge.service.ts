import { Injectable } from '@angular/core';
import { toBase64 } from './file-crypto';

/**
 * Minimal shape of the Capacitor runtime the native shell injects on `window`.
 * We talk to it through `Capacitor.Plugins` so the web build needs no Capacitor
 * dependency; the plugins exist only inside the mobile app.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    Clipboard?: {
      write(options: { string?: string; image?: string }): Promise<void>;
      read(): Promise<{ value: string; type?: string }>;
    };
    Share?: {
      share(options: {
        text?: string;
        title?: string;
        dialogTitle?: string;
        files?: string[];
      }): Promise<unknown>;
    };
    Filesystem?: {
      writeFile(options: {
        path: string;
        data: string;
        directory: 'CACHE';
        recursive?: boolean;
      }): Promise<{ uri: string }>;
    };
  };
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * Cross-platform clipboard/share bridge. Prefers native Capacitor plugins when
 * running inside the mobile app, and falls back to the browser's Clipboard and
 * Web Share APIs otherwise. Keeps the rest of the app platform-agnostic.
 */
@Injectable({ providedIn: 'root' })
export class NativeBridge {
  readonly isNative = !!capacitor()?.isNativePlatform?.();
  readonly platform = capacitor()?.getPlatform?.() ?? 'web';

  async copy(text: string): Promise<void> {
    const clip = capacitor()?.Plugins?.Clipboard;
    if (clip) {
      await clip.write({ string: text });
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  async readText(): Promise<string> {
    const clip = capacitor()?.Plugins?.Clipboard;
    if (clip) {
      return (await clip.read()).value;
    }
    return navigator.clipboard.readText();
  }

  /** Copies an image (data URL) to the OS clipboard. */
  async copyImage(dataUrl: string): Promise<void> {
    const clip = capacitor()?.Plugins?.Clipboard;
    if (clip) {
      await clip.write({ image: dataUrl });
      return;
    }
    const blob = await (await fetch(dataUrl)).blob();
    // ClipboardItem is available in secure contexts (Electron renderer, https).
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  }

  /** Whether this app can save a file natively (the mobile app). */
  get canSaveFile(): boolean {
    const plugins = capacitor()?.Plugins;
    return !!plugins?.Filesystem && !!plugins?.Share;
  }

  /**
   * Hands a downloaded file to the phone: writes it to the app's cache and
   * opens the share sheet, where the user saves it or opens it in an app.
   */
  async saveFile(name: string, bytes: Uint8Array): Promise<void> {
    const plugins = capacitor()?.Plugins;
    if (!plugins?.Filesystem || !plugins.Share) {
      throw new Error('Native file saving is unavailable');
    }
    // eslint-disable-next-line no-control-regex
    const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';
    const { uri } = await plugins.Filesystem.writeFile({
      path: `downloads/${Date.now()}/${safeName}`,
      data: toBase64(bytes),
      directory: 'CACHE',
      recursive: true,
    });
    await plugins.Share.share({ title: safeName, files: [uri] });
  }

  /** Whether a share sheet is available (native, or the Web Share API). */
  get canShare(): boolean {
    return !!capacitor()?.Plugins?.Share || typeof navigator.share === 'function';
  }

  async share(text: string): Promise<void> {
    const native = capacitor()?.Plugins?.Share;
    if (native) {
      await native.share({ text });
      return;
    }
    if (typeof navigator.share === 'function') {
      await navigator.share({ text });
    }
  }
}
