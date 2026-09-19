import { Injectable } from '@angular/core';

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
      share(options: { text?: string; title?: string; dialogTitle?: string }): Promise<unknown>;
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
