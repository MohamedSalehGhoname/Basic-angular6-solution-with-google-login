/**
 * Pure capture-policy logic, kept free of Electron so it can be unit-tested.
 * The desktop watcher reads the OS clipboard and asks these functions whether
 * a value should be captured into the encrypted vault.
 */

export type CaptureDecision =
  | { action: 'capture'; potentialSecret: boolean }
  | { action: 'skip'; reason: 'empty' | 'unchanged' | 'excluded' | 'secret' };

export interface PolicyInput {
  text: string;
  previousText: string | null;
  /** OS/clipboard formats currently present (e.g. from clipboard.availableFormats()). */
  formats: string[];
  /** When false (the default), values that look like secrets are not captured. */
  captureSecrets: boolean;
}

/**
 * Clipboard-format markers that password managers and the OS set to ask
 * clipboard managers not to record a value:
 * - Windows: `ExcludeClipboardContentFromMonitorProcessing`,
 *   `CanIncludeInClipboardHistory` (set to 0 by the app).
 * - macOS: `org.nspasteboard.ConcealedType` (NSPasteboard "concealed").
 */
const EXCLUSION_FORMAT_PATTERNS = [
  /excludeclipboardcontentfrommonitorprocessing/i,
  /canincludeinclipboardhistory/i,
  /org\.nspasteboard\.concealedtype/i,
  /org\.nspasteboard\.transientdata/i,
];

export function isExcludedFromHistory(formats: string[]): boolean {
  return formats.some((format) =>
    EXCLUSION_FORMAT_PATTERNS.some((pattern) => pattern.test(format)),
  );
}

/** Shannon entropy per character, in bits. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Best-effort heuristic for "this looks like a credential the user would not
 * want silently captured": TOTP codes, high-entropy tokens, and common secret
 * prefixes. Multi-line or whitespace-containing text is treated as prose and
 * never flagged.
 */
export function looksLikeSecret(text: string): boolean {
  // Private-key blocks contain whitespace, so check before the prose guard.
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
    return true;
  }
  const value = text.trim();
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  // TOTP / OTP codes: 6–8 digits.
  if (/^\d{6,8}$/.test(value)) {
    return true;
  }
  // Well-known secret prefixes (GitHub, Stripe, Slack, AWS, JWTs).
  if (/^(gh[opsu]_|xox[baprs]-|sk_(live|test)_|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.)/.test(value)) {
    return true;
  }
  // High-entropy token: long, no spaces, mixed character classes.
  if (value.length >= 20 && value.length <= 200) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) =>
      re.test(value),
    ).length;
    if (classes >= 3 && shannonEntropy(value) >= 3.5) {
      return true;
    }
  }
  return false;
}

export function evaluateCapture(input: PolicyInput): CaptureDecision {
  const text = input.text;
  if (text.trim().length === 0) {
    return { action: 'skip', reason: 'empty' };
  }
  if (input.previousText !== null && text === input.previousText) {
    return { action: 'skip', reason: 'unchanged' };
  }
  if (isExcludedFromHistory(input.formats)) {
    return { action: 'skip', reason: 'excluded' };
  }
  const potentialSecret = looksLikeSecret(text);
  if (potentialSecret && !input.captureSecrets) {
    return { action: 'skip', reason: 'secret' };
  }
  return { action: 'capture', potentialSecret };
}
