import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { SecretFields } from './secrets-store';
import { TOTP_DEFAULTS, type TotpConfig, formatCode, secondsRemaining, totpCode } from './totp';

/** The parts of an entry a code depends on. An unsaved form has them too. */
export type TotpFields = Pick<SecretFields, 'totp' | 'totpDigits' | 'totpPeriod' | 'totpAlgorithm'>;

/**
 * The live two-factor codes on screen.
 *
 * One clock for the whole app rather than a timer per entry: a page can show
 * dozens of codes and they all turn over on the same second anyway. Codes are
 * computed on demand and kept only in memory.
 */
@Injectable({ providedIn: 'root' })
export class TotpService {
  /** Ticks once a second, so anything reading it re-renders with the clock. */
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Seconds left on the current code for a given period. */
  readonly remaining = computed(() => (period: number) => secondsRemaining(period, this.now()));

  /** The current second, for anything that needs to recompute with the clock. */
  readonly tick = this.now.asReadonly();

  /** The settings for an entry's codes, or null when it has none. */
  config(secret: TotpFields): TotpConfig | null {
    if (!secret.totp) {
      return null;
    }
    return {
      secret: secret.totp,
      digits: secret.totpDigits ?? TOTP_DEFAULTS.digits,
      period: secret.totpPeriod ?? TOTP_DEFAULTS.period,
      algorithm: secret.totpAlgorithm ?? TOTP_DEFAULTS.algorithm,
    };
  }

  /** The code for an entry right now, or null when it has no two-factor set up. */
  async codeFor(secret: TotpFields): Promise<string | null> {
    const config = this.config(secret);
    return config ? totpCode(config) : null;
  }

  /** Seconds left on this entry's current code; 0 when it has none. */
  secondsLeft(secret: TotpFields): number {
    const config = this.config(secret);
    return config ? this.remaining()(config.period) : 0;
  }

  // --- Codes a template can read -------------------------------------------
  // Codes are derived asynchronously (WebCrypto) but a list needs them while
  // it renders, so each one is cached under its time slot and recomputed when
  // the shared clock crosses into the next.
  private readonly codes = signal<Map<string, string>>(new Map());
  private readonly computing = new Set<string>();

  /**
   * The formatted code for an entry, ready to render. Returns dots on the
   * first call for a slot and fills in a moment later, which re-renders
   * whatever read it. `id` only has to be stable and unique on the page —
   * an entry id, or the key itself for a form that is not saved yet.
   */
  liveCode(id: string, secret: TotpFields): string {
    const config = this.config(secret);
    if (!config) {
      return '';
    }
    // Reading the tick is what subscribes the caller to the clock.
    const slot = Math.floor(this.tick() / 1000 / config.period);
    const key = `${id}:${config.secret}:${slot}`;
    const known = this.codes().get(key);
    if (known !== undefined) {
      return known;
    }
    void this.compute(key, secret);
    // Show the code that just expired rather than a gap while the next one is
    // derived; it is a fraction of a second either way.
    return this.codes().get(`${id}:${config.secret}:${slot - 1}`) ?? '·'.repeat(config.digits);
  }

  private async compute(key: string, secret: TotpFields): Promise<void> {
    if (this.computing.has(key)) {
      return;
    }
    this.computing.add(key);
    try {
      const code = await this.codeFor(secret);
      if (code === null) {
        return;
      }
      this.codes.update((map) => {
        const next = new Map(map);
        // Old slots are never read again, so the cache does not need to grow
        // past what a page can show at once.
        if (next.size > 200) {
          next.clear();
        }
        next.set(key, formatCode(code));
        return next;
      });
    } finally {
      this.computing.delete(key);
    }
  }
}
