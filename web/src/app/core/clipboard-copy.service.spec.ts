import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardCopyService } from './clipboard-copy.service';

describe('ClipboardCopyService', () => {
  let service: ClipboardCopyService;
  let clipboardValue = '';
  let readable = true;

  beforeEach(() => {
    vi.useFakeTimers();
    clipboardValue = '';
    readable = true;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async (text: string) => {
          clipboardValue = text;
        }),
        readText: vi.fn(async () => {
          if (!readable) {
            throw new Error('read denied');
          }
          return clipboardValue;
        }),
      },
    });
    TestBed.configureTestingModule({});
    service = TestBed.inject(ClipboardCopyService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies without auto-clear for plain copy()', async () => {
    await service.copy('octocat');
    expect(clipboardValue).toBe('octocat');
    expect(service.secondsLeft()).toBe(0);
  });

  it('counts down and clears the clipboard when it still holds the value', async () => {
    await service.copyEphemeral('hunter2', 'password for GitHub', 3);
    expect(clipboardValue).toBe('hunter2');
    expect(service.secondsLeft()).toBe(3);
    expect(service.activeLabel()).toBe('password for GitHub');

    await vi.advanceTimersByTimeAsync(3000);
    expect(clipboardValue).toBe('');
    expect(service.secondsLeft()).toBe(0);
    expect(service.activeLabel()).toBeNull();
  });

  it('leaves the clipboard alone if the user copied something else', async () => {
    await service.copyEphemeral('hunter2', 'password', 2);
    clipboardValue = 'user copied this instead';

    await vi.advanceTimersByTimeAsync(2000);
    expect(clipboardValue).toBe('user copied this instead');
  });

  it('clears anyway when the clipboard cannot be read back', async () => {
    await service.copyEphemeral('hunter2', 'password', 2);
    readable = false;

    await vi.advanceTimersByTimeAsync(2000);
    expect(clipboardValue).toBe('');
  });

  it('clears immediately on demand', async () => {
    await service.copyEphemeral('hunter2', 'password', 12);
    await service.clearNow();
    expect(clipboardValue).toBe('');
    expect(service.secondsLeft()).toBe(0);
  });
});
