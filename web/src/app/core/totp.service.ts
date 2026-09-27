import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { SecretFields } from './secrets-store';
import { TOTP_DEFAULTS, type TotpConfig, secondsRemaining, totpCode } from './totp';

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
  config(secret: Pick<SecretFields, 'totp' | 'totpDigits' | 'totpPeriod' | 'totpAlgorithm'>):
    | TotpConfig
    | null {
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
  async codeFor(
    secret: Pick<SecretFields, 'totp' | 'totpDigits' | 'totpPeriod' | 'totpAlgorithm'>,
  ): Promise<string | null> {
    const config = this.config(secret);
    return config ? totpCode(config) : null;
  }
}
