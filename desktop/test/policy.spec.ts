import { describe, expect, it } from 'vitest';
import {
  evaluateCapture,
  isExcludedFromHistory,
  looksLikeSecret,
  type PolicyInput,
} from '../src/policy.js';

const input = (over: Partial<PolicyInput>): PolicyInput => ({
  text: 'hello world',
  image: null,
  previousText: null,
  previousImage: null,
  formats: ['text/plain'],
  captureSecrets: false,
  ...over,
});

describe('isExcludedFromHistory', () => {
  it('detects the Windows exclusion formats', () => {
    expect(isExcludedFromHistory(['text/plain', 'ExcludeClipboardContentFromMonitorProcessing'])).toBe(true);
    expect(isExcludedFromHistory(['CanIncludeInClipboardHistory'])).toBe(true);
  });

  it('detects the macOS concealed pasteboard type', () => {
    expect(isExcludedFromHistory(['org.nspasteboard.ConcealedType'])).toBe(true);
  });

  it('passes ordinary formats through', () => {
    expect(isExcludedFromHistory(['text/plain', 'text/html'])).toBe(false);
  });
});

describe('looksLikeSecret', () => {
  it('flags TOTP-shaped codes', () => {
    expect(looksLikeSecret('123456')).toBe(true);
    expect(looksLikeSecret('49322110')).toBe(true);
  });

  it('flags known secret prefixes and private keys', () => {
    expect(looksLikeSecret('ghp_0123456789abcdefABCDEF0123456789abcdef')).toBe(true);
    expect(looksLikeSecret('sk_live_51H8xYzABCDefGHijkLMNop')).toBe(true);
    expect(looksLikeSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
  });

  it('flags high-entropy mixed tokens', () => {
    expect(looksLikeSecret('Xq7$rT9!vB2@kL5#pW8z')).toBe(true);
  });

  it('does not flag ordinary text, prose, or URLs', () => {
    expect(looksLikeSecret('hello world')).toBe(false);
    expect(looksLikeSecret('Meeting notes for tomorrow')).toBe(false);
    expect(looksLikeSecret('https://github.com/some/repo')).toBe(false);
    expect(looksLikeSecret('octocat')).toBe(false);
  });
});

describe('evaluateCapture', () => {
  it('captures ordinary new text', () => {
    expect(evaluateCapture(input({ text: 'a fresh note' }))).toEqual({
      action: 'capture',
      kind: 'text',
      potentialSecret: false,
    });
  });

  it('skips empty and unchanged values', () => {
    expect(evaluateCapture(input({ text: '   ' }))).toEqual({ action: 'skip', reason: 'empty' });
    expect(evaluateCapture(input({ text: 'same', previousText: 'same' }))).toEqual({
      action: 'skip',
      reason: 'unchanged',
    });
  });

  it('skips values the OS marks as excluded unless capturing everything', () => {
    expect(
      evaluateCapture(input({ text: 'secret', formats: ['CanIncludeInClipboardHistory'] })),
    ).toEqual({ action: 'skip', reason: 'excluded' });
    expect(
      evaluateCapture(
        input({
          text: 'Tr0ub4dor&3-horse!battery',
          formats: ['ExcludeClipboardContentFromMonitorProcessing'],
          captureSecrets: true,
        }),
      ),
    ).toEqual({ action: 'capture', kind: 'text', potentialSecret: true });
    expect(
      evaluateCapture(
        input({ text: '', image: 'data:image/png;base64,AA', formats: ['org.nspasteboard.ConcealedType'], captureSecrets: true }),
      ),
    ).toEqual({ action: 'capture', kind: 'image' });
  });

  it('skips likely secrets by default but captures them when opted in', () => {
    expect(evaluateCapture(input({ text: '123456' }))).toEqual({
      action: 'skip',
      reason: 'secret',
    });
    expect(evaluateCapture(input({ text: '123456', captureSecrets: true }))).toEqual({
      action: 'capture',
      kind: 'text',
      potentialSecret: true,
    });
  });

  it('captures a new clipboard image when there is no text', () => {
    const image = 'data:image/png;base64,AAAA';
    expect(evaluateCapture(input({ text: '', image }))).toEqual({
      action: 'capture',
      kind: 'image',
    });
    // Unchanged image is skipped.
    expect(evaluateCapture(input({ text: '', image, previousImage: image }))).toEqual({
      action: 'skip',
      reason: 'unchanged',
    });
  });

  it('prefers text over an image when both are present', () => {
    expect(
      evaluateCapture(input({ text: 'note', image: 'data:image/png;base64,AAAA' })),
    ).toMatchObject({ action: 'capture', kind: 'text' });
  });
});
