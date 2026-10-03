import { Injectable, signal } from '@angular/core';

/** What Android is waiting for, once the app has been opened to answer it. */
export interface AutofillRequest {
  kind: 'fill' | 'save';
  /** The site or app the fields belong to; what secrets are matched against. */
  identity: string | null;
  webDomain: string | null;
  packageName: string | null;
  wantsUsername: boolean;
  wantsPassword: boolean;
  /** Only on a save request: what the user typed into the form. */
  username: string | null;
  password: string | null;
}

interface AutofillPlugin {
  status(): Promise<{ supported: boolean; enabled: boolean }>;
  openSettings(): Promise<void>;
  pending(): Promise<
    Partial<AutofillRequest> & { kind: 'fill' | 'save' | null }
  >;
  respond(options: { username: string; password: string; label?: string }): Promise<void>;
  cancel(): Promise<void>;
}

function plugin(): AutofillPlugin | null {
  const capacitor = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    .Capacitor;
  return (capacitor?.Plugins?.['Autofill'] as AutofillPlugin | undefined) ?? null;
}

/**
 * Android's autofill, from the app's side.
 *
 * The native service cannot read the vault, so when the user picks our
 * suggestion Android opens the app and waits for it to hand back the values.
 * `request` holds that pending question while the autofill page answers it.
 */
@Injectable({ providedIn: 'root' })
export class AutofillService {
  /** Whether this device offers autofill at all (Android 8+ in the app). */
  readonly supported = signal(false);
  /** Whether the user picked this app as their autofill service. */
  readonly enabled = signal(false);
  /** The request this launch is answering, if the app was opened by Android. */
  readonly request = signal<AutofillRequest | null>(null);

  /** True once the pending request has been read, so routing can wait for it. */
  readonly ready = this.readPending();

  async refreshStatus(): Promise<void> {
    const native = plugin();
    if (!native) {
      this.supported.set(false);
      this.enabled.set(false);
      return;
    }
    try {
      const status = await native.status();
      this.supported.set(status.supported);
      this.enabled.set(status.enabled);
    } catch {
      this.supported.set(false);
      this.enabled.set(false);
    }
  }

  /** Sends the user to the Android screen where autofill services are chosen. */
  async openSettings(): Promise<void> {
    await plugin()?.openSettings();
  }

  /** Answers a fill request and closes the window Android opened. */
  async respond(secret: { username: string; password: string; title?: string }): Promise<void> {
    const native = plugin();
    if (!native) {
      return;
    }
    await native.respond({
      username: secret.username,
      password: secret.password,
      label: secret.title || secret.username,
    });
  }

  /** Closes the window without filling anything. */
  async cancel(): Promise<void> {
    await plugin()?.cancel();
  }

  private async readPending(): Promise<AutofillRequest | null> {
    const native = plugin();
    if (!native) {
      return null;
    }
    try {
      const pending = await native.pending();
      if (!pending?.kind) {
        return null;
      }
      const request: AutofillRequest = {
        kind: pending.kind,
        identity: pending.identity ?? null,
        webDomain: pending.webDomain ?? null,
        packageName: pending.packageName ?? null,
        wantsUsername: pending.wantsUsername ?? false,
        wantsPassword: pending.wantsPassword ?? false,
        username: pending.username ?? null,
        password: pending.password ?? null,
      };
      this.request.set(request);
      return request;
    } catch {
      return null;
    }
  }
}

/**
 * How well a stored secret matches what Android is asking for.
 *
 * Higher is better; 0 means no reason to think they belong together. The URL
 * a user types is rarely exactly the domain a browser reports, so this
 * compares registrable-looking suffixes rather than whole strings, and falls
 * back to the title for apps, where the identity is a package name like
 * `com.instagram.android` and nobody stores that.
 */
export function matchScore(secret: { title: string; url: string }, identity: string): number {
  const target = identity.trim().toLowerCase();
  if (!target) {
    return 0;
  }
  const host = hostOf(secret.url);
  if (host) {
    if (host === target) {
      return 100;
    }
    if (host.endsWith(`.${target}`) || target.endsWith(`.${host}`)) {
      return 80;
    }
  }
  // An app's package name: com.instagram.android -> instagram
  const words = target.split(/[.\-_/]/).filter((word) => word.length > 2 && !GENERIC.has(word));
  const title = secret.title.toLowerCase();
  for (const word of words) {
    if (title.includes(word) || (host && host.includes(word))) {
      return 60;
    }
  }
  return 0;
}

const GENERIC = new Set(['com', 'org', 'net', 'www', 'app', 'android', 'mobile', 'client']);

function hostOf(url: string): string | null {
  const text = url.trim();
  if (!text) {
    return null;
  }
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}
