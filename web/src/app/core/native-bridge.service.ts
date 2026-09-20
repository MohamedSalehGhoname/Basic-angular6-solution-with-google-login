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
    // Our own plugin (mobile/plugins/share-receiver), which downloads and
    // decrypts files natively so the work survives the background.
    ShareReceiver?: {
      download(options: {
        id: string;
        url: string;
        name: string;
        key: string | null;
      }): Promise<{ uri: string; path: string }>;
      requestNotifications?(): Promise<void>;
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

  /** Whether the phone app can download and save a file by itself. */
  get canSaveFile(): boolean {
    const plugins = capacitor()?.Plugins;
    return !!plugins?.ShareReceiver?.download && !!plugins?.Share;
  }

  /**
   * Downloads (and decrypts) a file natively, outside the web page: the
   * phone keeps it running with the app in the background or the screen
   * off, and progress arrives as ShareReceiver "progress" events. Resolves
   * with the saved file's uri.
   */
  async downloadFile(args: {
    id: string;
    url: string;
    name: string;
    key: string | null;
  }): Promise<string> {
    const receiver = capacitor()?.Plugins?.ShareReceiver;
    if (!receiver?.download) {
      throw new Error('Native download is unavailable');
    }
    await receiver.requestNotifications?.().catch(() => undefined);
    const { uri } = await receiver.download(args);
    return uri;
  }

  /** Opens the phone's share sheet for a saved file, to keep or open it. */
  async shareFile(name: string, uri: string): Promise<void> {
    await capacitor()?.Plugins?.Share?.share({ title: name, files: [uri] });
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
