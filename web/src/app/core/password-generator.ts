export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
}

const SETS = {
  lowercase: 'abcdefghijkmnpqrstuvwxyz', // no l, o (ambiguous)
  uppercase: 'ABCDEFGHJKLMNPQRSTUVWXYZ', // no I, O
  digits: '23456789', // no 0, 1
  symbols: '!@#$%^&*-_=+?',
} as const;

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
};

/** Uniform random index in [0, max) using rejection sampling (no modulo bias). */
function randomIndex(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return value % max;
}

function pick(alphabet: string): string {
  return alphabet[randomIndex(alphabet.length)]!;
}

/**
 * Generates a random password from the selected character classes using a
 * CSPRNG. Guarantees at least one character from each selected class, then
 * shuffles so the guaranteed characters are not positionally predictable.
 */
export function generatePassword(options: PasswordOptions): string {
  const selected = (Object.keys(SETS) as (keyof typeof SETS)[]).filter((key) => options[key]);
  if (selected.length === 0) {
    throw new Error('Select at least one character type.');
  }
  const length = Math.max(selected.length, Math.min(128, Math.floor(options.length)));

  const chars: string[] = selected.map((key) => pick(SETS[key]));
  const all = selected.map((key) => SETS[key]).join('');
  while (chars.length < length) {
    chars.push(pick(all));
  }

  // Fisher–Yates shuffle with CSPRNG indices.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
