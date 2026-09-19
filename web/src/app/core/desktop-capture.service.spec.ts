import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultStatus } from './vault.service';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import { DesktopCaptureService } from './desktop-capture.service';
import { VaultService } from './vault.service';

class FakeDesktop {
  isDesktop = true as const;
  enabledFlag = false;
  private cb: ((p: unknown) => void) | null = null;
  onCaptured(cb: (p: unknown) => void): () => void {
    this.cb = cb;
    return () => {
      this.cb = null;
    };
  }
  setCaptureEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }
  setCaptureSecrets(): void {}
  emit(text: string): void {
    this.cb?.({ kind: 'text', text, potentialSecret: false });
  }
  emitImage(image: string): void {
    this.cb?.({ kind: 'image', image });
  }
}

describe('DesktopCaptureService', () => {
  const user = signal<{ uid: string } | null>({ uid: 'u1' });
  let status: WritableSignal<VaultStatus>;
  let add: ReturnType<typeof vi.fn>;
  let addImage: ReturnType<typeof vi.fn>;
  let desktop: FakeDesktop;

  const inject = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: VaultService, useValue: { status } },
        { provide: ClipboardStore, useValue: { add, addImage } },
      ],
    });
    return TestBed.inject(DesktopCaptureService);
  };

  beforeEach(() => {
    localStorage.clear();
    user.set({ uid: 'u1' });
    status = signal<VaultStatus>('unlocked');
    add = vi.fn(async () => null);
    addImage = vi.fn(async () => null);
    desktop = new FakeDesktop();
    (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop = desktop;
  });

  afterEach(() => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
  });

  it('is unavailable and inert without the desktop bridge', () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    const service = inject();
    expect(service.available).toBe(false);
    service.setEnabled(true); // no throw, no bridge
    expect(service.enabled()).toBe(true);
  });

  it('captures into the clipboard store when enabled and unlocked', async () => {
    localStorage.setItem('clipsync.desktop.capture', 'true');
    const service = inject();
    expect(service.available).toBe(true);
    expect(desktop.enabledFlag).toBe(true);

    desktop.emit('copied on desktop');
    await Promise.resolve();
    expect(add).toHaveBeenCalledWith('copied on desktop', { device: 'Desktop' });
  });

  it('routes a captured image to addImage', async () => {
    localStorage.setItem('clipsync.desktop.capture', 'true');
    inject();
    desktop.emitImage('data:image/png;base64,AAAA');
    await Promise.resolve();
    expect(addImage).toHaveBeenCalledWith('data:image/png;base64,AAAA', { device: 'Desktop' });
    expect(add).not.toHaveBeenCalled();
  });

  it('does not capture while disabled', async () => {
    const service = inject();
    expect(service.enabled()).toBe(false);
    desktop.emit('ignored');
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
  });

  it('buffers captures while locked and flushes them on unlock', async () => {
    localStorage.setItem('clipsync.desktop.capture', 'true');
    status.set('locked');
    inject();

    desktop.emit('one');
    desktop.emit('two');
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();

    status.set('unlocked');
    TestBed.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(add.mock.calls.map((c) => c[0])).toEqual(['one', 'two']);
  });

  it('drops the buffer when capture is turned off', async () => {
    localStorage.setItem('clipsync.desktop.capture', 'true');
    status.set('locked');
    const service = inject();

    desktop.emit('pending');
    await Promise.resolve();
    service.setEnabled(false);

    status.set('unlocked');
    TestBed.tick();
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
    expect(desktop.enabledFlag).toBe(false);
  });
});
