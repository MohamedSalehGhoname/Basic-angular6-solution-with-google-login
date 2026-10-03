import { describe, expect, it } from 'vitest';
import { ClipboardWatcher, type Captured, type ClipboardSnapshot } from '../src/clipboard-watcher.js';

function makeWatcher(overrides: {
  enabled?: boolean;
  captureSecrets?: boolean;
} = {}) {
  let snapshot: ClipboardSnapshot = { text: '', image: null, formats: ['text/plain'] };
  let enabled = overrides.enabled ?? true;
  const captured: Captured[] = [];
  const skips: string[] = [];

  const watcher = new ClipboardWatcher({
    read: () => snapshot,
    isEnabled: () => enabled,
    captureSecrets: () => overrides.captureSecrets ?? false,
    onCapture: (c) => captured.push(c),
    onSkip: (d) => skips.push(d.reason),
  });

  return {
    watcher,
    captured,
    skips,
    texts: () => captured.map((c) => (c.kind === 'text' ? c.text : c.image)),
    poll: () => watcher.poll(),
    set: (text: string, formats = ['text/plain']) => {
      snapshot = { text, image: null, formats };
    },
    setImage: (image: string | null, formats = ['image/png']) => {
      snapshot = { text: '', image, formats };
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('ClipboardWatcher', async () => {
  it('captures each new clipboard value once', async () => {
    const h = makeWatcher();
    h.set('first');
    await h.poll();
    await h.poll(); // unchanged
    h.set('second');
    await h.poll();

    expect(h.texts()).toEqual(['first', 'second']);
    expect(h.skips).toContain('unchanged');
  });

  it('does not capture while disabled, and does not replay on re-enable', async () => {
    const h = makeWatcher({ enabled: false });
    h.set('copied while off');
    await h.poll();
    expect(h.captured).toEqual([]);

    // Re-enable: the value already on the clipboard must not be captured.
    h.setEnabled(true);
    await h.poll();
    expect(h.captured).toEqual([]);

    // A genuinely new value is captured.
    h.set('copied while on');
    await h.poll();
    expect(h.texts()).toEqual(['copied while on']);
  });

  it('skips values excluded by the OS', async () => {
    const h = makeWatcher();
    h.set('password', ['CanIncludeInClipboardHistory']);
    await h.poll();
    expect(h.captured).toEqual([]);
    expect(h.skips).toContain('excluded');
  });

  it('skips likely secrets but marks captured ones when opted in', async () => {
    const off = makeWatcher();
    off.set('123456');
    await off.poll();
    expect(off.captured).toEqual([]);
    expect(off.skips).toContain('secret');

    const on = makeWatcher({ captureSecrets: true });
    on.set('123456');
    await on.poll();
    expect(on.captured).toEqual([{ kind: 'text', text: '123456', potentialSecret: true }]);
  });

  it('captures a new clipboard image once', async () => {
    const h = makeWatcher();
    const image = 'data:image/png;base64,AAAA';
    h.setImage(image);
    await h.poll();
    await h.poll(); // unchanged image → skipped
    h.setImage('data:image/png;base64,BBBB');
    await h.poll();

    expect(h.captured).toEqual([
      { kind: 'image', image },
      { kind: 'image', image: 'data:image/png;base64,BBBB' },
    ]);
    expect(h.skips).toContain('unchanged');
  });
});
