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
    // Our own plugin (mobile/plugins/share-receiver), which also writes
    // downloads to disk a piece at a time.
    ShareReceiver?: {
      saveBegin(options: { name: string }): Promise<{ token: string }>;
      saveChunk(options: { token: string; data: string }): Promise<void>;
      saveFinish(options: { token: string }): Promise<{ uri: string }>;
      saveCancel(options: { token: string }): Promise<void>;
    };
  };
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** Somewhere a downloaded file is written, a piece at a time. */
export interface FileSink {
  write(bytes: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
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
    return !!plugins?.ShareReceiver?.saveBegin && !!plugins?.Share;
  }

  /**
   * Starts saving a downloaded file on the phone. The caller writes it in
   * pieces — each one goes straight to a file in the app's cache, so a large
   * download never sits in the WebView's memory — and finish() opens the
   * share sheet to save it or open it in an app.
   */
  async startFileSave(name: string): Promise<FileSink> {
    const plugins = capacitor()?.Plugins;
    const receiver = plugins?.ShareReceiver;
    const share = plugins?.Share;
    if (!receiver || !share) {
      throw new Error('Native file saving is unavailable');
    }
    const { token } = await receiver.saveBegin({ name });
    return {
      write: (bytes) => receiver.saveChunk({ token, data: toBase64(bytes) }),
      finish: async () => {
        const { uri } = await receiver.saveFinish({ token });
        await share.share({ title: name, files: [uri] });
      },
      cancel: () => receiver.saveCancel({ token }).catch(() => undefined),
    };
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
