import { Injectable, signal } from '@angular/core';

interface QrScannerPlugin {
  available(): Promise<{ available: boolean }>;
  scan(): Promise<{ value: string }>;
}

function plugin(): QrScannerPlugin | null {
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (capacitor?.Plugins?.['QrScanner'] as QrScannerPlugin | undefined) ?? null;
}

/** Thrown when the user backed out of the scanner; not worth showing. */
export const SCAN_CANCELLED = 'cancelled';

/**
 * Reading a QR code with the phone's camera.
 *
 * The scanning happens inside Google Play services, so the app holds no
 * camera permission and never receives an image — only the text. On anything
 * that is not the phone app, `supported` stays false and the caller falls
 * back to typing.
 */
@Injectable({ providedIn: 'root' })
export class QrScannerService {
  readonly supported = signal(false);

  constructor() {
    void this.check();
  }

  private async check(): Promise<void> {
    const native = plugin();
    if (!native) {
      return;
    }
    try {
      this.supported.set((await native.available()).available);
    } catch {
      this.supported.set(false);
    }
  }

  /** The text of one scanned code, or null when the user backed out. */
  async scan(): Promise<string | null> {
    const native = plugin();
    if (!native) {
      return null;
    }
    try {
      return (await native.scan()).value;
    } catch (err) {
      if ((err as { code?: string })?.code === SCAN_CANCELLED) {
        return null;
      }
      throw err;
    }
  }
}
