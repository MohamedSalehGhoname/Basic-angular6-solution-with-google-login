import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoLockService } from './auto-lock.service';
import { VaultService, type VaultStatus } from './vault.service';

describe('AutoLockService', () => {
  const status = signal<VaultStatus>('unlocked');
  let locked: number;
  let service: AutoLockService;

  const configure = () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: VaultService,
          useValue: {
            status,
            lock: () => {
              locked += 1;
              status.set('locked');
            },
          },
        },
      ],
    });
    service = TestBed.inject(AutoLockService);
  };

  beforeEach(() => {
    localStorage.clear();
    status.set('unlocked');
    locked = 0;
    configure();
  });

  const minutesAgo = (n: number) => Date.now() + n * 60_000;

  it('locks once the vault has been left alone for the chosen time', () => {
    service.set(5);
    expect(service.lockIfIdle(minutesAgo(4))).toBe(false);
    expect(locked).toBe(0);

    expect(service.lockIfIdle(minutesAgo(5))).toBe(true);
    expect(locked).toBe(1);
  });

  it('starts the clock over whenever the vault is used', () => {
    service.set(1);
    service.touch();
    expect(service.lockIfIdle(minutesAgo(0.9))).toBe(false);
    // Used again just before the minute was up.
    service.touch();
    expect(service.lockIfIdle(minutesAgo(0.9))).toBe(false);
    expect(locked).toBe(0);
  });

  it('never locks when the setting is off', () => {
    service.set(0);
    expect(service.lockIfIdle(minutesAgo(600))).toBe(false);
    expect(locked).toBe(0);
  });

  it('does nothing when the vault is already locked', () => {
    service.set(1);
    status.set('locked');
    expect(service.lockIfIdle(minutesAgo(60))).toBe(false);
    expect(locked).toBe(0);
  });

  it('counts time spent in the background', () => {
    service.set(5);
    // Hidden at t, brought back six minutes later: the away time is idle time.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(service.lockIfIdle(minutesAgo(6))).toBe(true);
    expect(locked).toBe(1);
  });

  it('locks by default on a device that has never chosen', () => {
    // An empty preference must not read as "never": that would ship every
    // install with the lock turned off.
    expect(localStorage.getItem('clipsync.autolock')).toBeNull();
    expect(service.minutes()).toBe(15);
    expect(service.lockIfIdle(minutesAgo(16))).toBe(true);
  });

  it('remembers an explicit "never"', () => {
    service.set(0);
    TestBed.resetTestingModule();
    configure();
    expect(service.minutes()).toBe(0);
  });

  it('keeps the choice for next time, and defaults sensibly', () => {
    service.set(15);
    expect(localStorage.getItem('clipsync.autolock')).toBe('15');

    TestBed.resetTestingModule();
    configure();
    expect(service.minutes()).toBe(15);

    localStorage.setItem('clipsync.autolock', 'nonsense');
    TestBed.resetTestingModule();
    configure();
    expect(service.minutes()).toBe(15);
  });

  it('re-arms when the vault is unlocked again', async () => {
    service.set(1);
    status.set('locked');
    (await TestBed.inject(AutoLockService)) && TestBed.tick();
    const touch = vi.spyOn(service, 'touch');
    status.set('unlocked');
    TestBed.tick();
    expect(touch).toHaveBeenCalled();
  });
});
