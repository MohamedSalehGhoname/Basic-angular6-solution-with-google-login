import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeBridge } from './native-bridge.service';

function setCapacitor(value: unknown): void {
  (window as unknown as { Capacitor?: unknown }).Capacitor = value;
}

describe('NativeBridge', () => {
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    vi.restoreAllMocks();
  });

  describe('in a plain browser', () => {
    let bridge: NativeBridge;
    beforeEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(async () => {}), readText: vi.fn(async () => 'from-browser') },
      });
      TestBed.configureTestingModule({});
      bridge = TestBed.inject(NativeBridge);
    });

    it('reports web platform and uses the browser clipboard', async () => {
      expect(bridge.isNative).toBe(false);
      expect(bridge.platform).toBe('web');
      await bridge.copy('hello');
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
      expect(await bridge.readText()).toBe('from-browser');
    });
  });

  describe('inside the native app', () => {
    let bridge: NativeBridge;
    const clipboard = { write: vi.fn(async () => {}), read: vi.fn(async () => ({ value: 'from-native' })) };
    const share = { share: vi.fn(async () => {}) };

    beforeEach(() => {
      setCapacitor({
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: { Clipboard: clipboard, Share: share },
      });
      TestBed.configureTestingModule({});
      bridge = TestBed.inject(NativeBridge);
    });

    it('reports the native platform and uses the Capacitor plugins', async () => {
      expect(bridge.isNative).toBe(true);
      expect(bridge.platform).toBe('android');

      await bridge.copy('secret');
      expect(clipboard.write).toHaveBeenCalledWith({ string: 'secret' });
      expect(await bridge.readText()).toBe('from-native');

      expect(bridge.canShare).toBe(true);
      await bridge.share('shared text');
      expect(share.share).toHaveBeenCalledWith({ text: 'shared text' });
    });
  });
});
