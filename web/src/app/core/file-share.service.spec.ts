import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { ClipboardStore } from './clipboard-store';
import type { FileSendRequest } from './desktop-capture.service';
import { encryptedSize, fromBase64 } from './file-crypto';
import { FileShareService } from './file-share.service';
import { NativeBridge } from './native-bridge.service';
import { FileRequestError, SyncApi } from './sync-api';
import { VaultService, type VaultStatus } from './vault.service';

// Produced by the desktop app; see file-crypto.spec.ts.
const VECTOR =
  'Q1NGMQAAABABAgMEBQYHCL6d/6qTGlqozzdwam5xukw+4a5O+YKLFFqmA4qa3Q6EboTlgCv+kgwzfoB16bde1oK+ajnEnSpXoikj+fUS4/jkkcVaJkZiNPlctDQA+F2Oq+KYl5f41SC5YUZvRU4ivQ==';

class FakeDesktop {
  isDesktop = true as const;
  sends: ((request: FileSendRequest) => void) | null = null;
  pending: FileSendRequest[] = [];
  uploads: { requestId: string; uploadUrl: string; key: string | null }[] = [];
  forgotten: string[] = [];
  shown = 0;
  downloads: unknown[] = [];
  uploadError: Error | null = null;

  onCaptured() {
    return () => {};
  }
  setCaptureEnabled() {}
  setCaptureSecrets() {}
  async onFileSend(callback: (request: FileSendRequest) => void) {
    this.sends = callback;
    this.pending.forEach(callback);
    return () => {};
  }
  async uploadFile(requestId: string, uploadUrl: string, key: string | null) {
    if (this.uploadError) {
      throw this.uploadError;
    }
    this.uploads.push({ requestId, uploadUrl, key });
  }
  forgetFile(requestId: string) {
    this.forgotten.push(requestId);
  }
  async downloadFile(args: unknown) {
    this.downloads.push(args);
    return 'C:\\Downloads\\x';
  }
  onFileProgress() {
    return () => {};
  }
  showWindow() {
    this.shown += 1;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A Response whose body arrives in two pieces, like a real download. */
function streamed(bytes: Uint8Array): Response {
  const half = Math.ceil(bytes.length / 2);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, half));
        controller.enqueue(bytes.subarray(half));
        controller.close();
      },
    }),
    { headers: { 'content-length': String(bytes.length) } },
  );
}

describe('FileShareService', () => {
  const user = signal<{ uid: string } | null>({ uid: 'u1' });
  let status: WritableSignal<VaultStatus>;
  let desktop: FakeDesktop;
  let api: {
    createFile: ReturnType<typeof vi.fn>;
    confirmFile: ReturnType<typeof vi.fn>;
    fileDownloadUrl: ReturnType<typeof vi.fn>;
    fileContent: ReturnType<typeof vi.fn>;
  };
  let addFile: ReturnType<typeof vi.fn>;
  let addText: ReturnType<typeof vi.fn>;
  let native: { canSaveFile: boolean; downloadFile: ReturnType<typeof vi.fn> };

  const inject = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { user } },
        { provide: VaultService, useValue: { status } },
        { provide: ClipboardStore, useValue: { addFile, add: addText } },
        { provide: SyncApi, useValue: api },
        { provide: NativeBridge, useValue: native },
      ],
    });
    return TestBed.inject(FileShareService);
  };

  const request = (name = 'report.pdf', sizeBytes = 1000): FileSendRequest => ({
    requestId: `req-${name}`,
    name,
    sizeBytes,
  });

  beforeEach(() => {
    localStorage.clear();
    user.set({ uid: 'u1' });
    status = signal<VaultStatus>('unlocked');
    desktop = new FakeDesktop();
    (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop = desktop;
    api = {
      createFile: vi.fn(async () => ({
        fileId: 'fil_1',
        uploadUrl: 'https://storage/put',
        uploadExpiresAt: '',
      })),
      confirmFile: vi.fn(async () => undefined),
      fileDownloadUrl: vi.fn(async () => 'https://storage/get'),
      fileContent: vi.fn(async () => streamed(fromBase64(VECTOR))),
    };
    addFile = vi.fn(async () => null);
    addText = vi.fn(async () => null);
    native = {
      canSaveFile: false,
      downloadFile: vi.fn(async () => 'Download/vector.txt'),
    };
  });

  afterEach(() => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
  });

  it('cannot send without the desktop bridge', () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    expect(inject().canSend).toBe(false);
  });

  it('encrypts by default: random name upstream, key kept in the clipboard item', async () => {
    inject();
    desktop.sends!(request());
    await flush();

    expect(api.createFile).toHaveBeenCalledWith({
      sizeBytes: encryptedSize(1000),
      encrypted: true,
      name: undefined,
    });
    const upload = desktop.uploads[0]!;
    expect(upload.uploadUrl).toBe('https://storage/put');
    expect(fromBase64(upload.key!)).toHaveLength(32);
    expect(api.confirmFile).toHaveBeenCalledWith('fil_1');
    expect(addFile).toHaveBeenCalledWith(
      { id: 'fil_1', name: 'report.pdf', size: 1000, key: upload.key },
      { device: 'Desktop' },
    );
  });

  it('sends as-is when encryption is turned off', async () => {
    const service = inject();
    service.setEncrypt(false);
    expect(localStorage.getItem('clipsync.files.encrypt')).toBe('false');
    desktop.sends!(request('notes.txt', 50));
    await flush();

    expect(api.createFile).toHaveBeenCalledWith({
      sizeBytes: 50,
      encrypted: false,
      name: 'notes.txt',
    });
    expect(desktop.uploads[0]!.key).toBeNull();
    expect(addFile).toHaveBeenCalledWith(
      { id: 'fil_1', name: 'notes.txt', size: 50 },
      { device: 'Desktop' },
    );
  });

  it('picks up files sent before the app was listening', async () => {
    desktop.pending = [request('early.zip')];
    inject();
    await flush();
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it('holds sends while locked, asks for the window, and sends on unlock', async () => {
    status.set('locked');
    const service = inject();
    desktop.sends!(request());
    await flush();
    expect(api.createFile).not.toHaveBeenCalled();
    expect(desktop.shown).toBe(1);
    expect(service.transfers()[0]).toMatchObject({ name: 'report.pdf', waiting: true });

    status.set('unlocked');
    TestBed.tick();
    await flush();
    expect(addFile).toHaveBeenCalledTimes(1);
    expect(service.transfers()).toEqual([]);
  });

  it('reports a server without file storage and lets the desktop drop the file', async () => {
    api.createFile.mockRejectedValue(new FileRequestError(503));
    const service = inject();
    desktop.sends!(request());
    await flush();
    expect(service.transfers()[0]!.error).toBe('files.error.notConfigured');
    expect(desktop.forgotten).toEqual(['req-report.pdf']);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('does not add an item when the upload fails', async () => {
    desktop.uploadError = new Error('socket hang up');
    const service = inject();
    desktop.sends!(request());
    await flush();
    expect(api.confirmFile).not.toHaveBeenCalled();
    expect(addFile).not.toHaveBeenCalled();
    expect(service.transfers()[0]!.error).toBe('files.error.transfer');
  });

  it('refuses empty files', async () => {
    const service = inject();
    desktop.sends!(request('empty.txt', 0));
    await flush();
    expect(api.createFile).not.toHaveBeenCalled();
    expect(service.transfers()[0]!.error).toBe('files.error.empty');
  });

  it('lets the desktop app download (and decrypt) straight to disk', async () => {
    const service = inject();
    await service.download({ id: 'fil_1', name: 'a.pdf', size: 10, key: 'KEY' });
    expect(desktop.downloads).toEqual([
      { id: 'down-fil_1', downloadUrl: 'https://storage/get', name: 'a.pdf', key: 'KEY' },
    ]);
    expect(service.transfers()).toEqual([]);
  });

  it('decrypts in the browser through the server relay', async () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    const saved: { name: string; blob: Blob }[] = [];
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved.push({ name: '', blob: blob as Blob });
      return 'blob:x';
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        saved.at(-1)!.name = this.download;
      });

    const service = inject();
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await service.download({ id: 'fil_1', name: 'vector.txt', size: 48, key });

    expect(api.fileContent).toHaveBeenCalledWith('fil_1');
    expect(saved[0]!.name).toBe('vector.txt');
    expect(await saved[0]!.blob.text()).toBe('Clipboard Sync shared test vector, three chunks!');
    createUrl.mockRestore();
    click.mockRestore();
  });

  it('opens the direct link in a browser for a file sent as-is', async () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    let opened = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        opened = this.href;
      });
    await inject().download({ id: 'fil_1', name: 'n.txt', size: 5 });
    expect(opened).toBe('https://storage/get');
    expect(api.fileContent).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('on the phone, hands the download to the native plugin with a storage link', async () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    native.canSaveFile = true;
    const service = inject();
    await service.download({ id: 'fil_1', name: 'vector.txt', size: 48, key: 'KEY' });

    expect(api.fileDownloadUrl).toHaveBeenCalledWith('fil_1');
    expect(native.downloadFile).toHaveBeenCalledWith({
      id: 'down-fil_1',
      url: 'https://storage/get',
      name: 'vector.txt',
      key: 'KEY',
    });
    // Saved into the phone's Downloads folder, and the app says where.
    expect(service.savedTo()).toBe('Download/vector.txt');
    expect(service.transfers()).toEqual([]);
  });

  it('reports a failed phone download instead of leaving it spinning', async () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    native.canSaveFile = true;
    native.downloadFile.mockRejectedValue(new Error('Download failed: status 403'));
    const service = inject();
    await service.download({ id: 'fil_1', name: 'x.bin', size: 10 });
    expect(service.transfers()[0]!.error).toBe('files.error.transfer');
    expect(service.savedTo()).toBeNull();
  });

  it('refuses files too large for the phone', async () => {
    delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
    native.canSaveFile = true;
    const service = inject();
    await service.download({ id: 'fil_1', name: 'big.iso', size: 600 * 1024 * 1024 });
    expect(native.downloadFile).not.toHaveBeenCalled();
    expect(service.transfers()[0]!.error).toBe('files.error.tooLargePhone');
  });

  describe('phone share sheet', () => {
    type Item =
      | { kind: 'text'; text: string }
      | { kind: 'file'; requestId: string; name: string; sizeBytes: number };
    let listeners: Record<string, (value: never) => void>;
    let receiver: {
      pending: Item[];
      uploads: unknown[];
      forgotten: unknown[];
      takePending: () => Promise<{ items: Item[] }>;
      upload: (options: unknown) => Promise<void>;
      forget: (options: unknown) => Promise<void>;
      addListener: (event: string, cb: (value: never) => void) => Promise<unknown>;
    };
    const share = (item: Item) => listeners['share']!(item as never);

    beforeEach(() => {
      delete (window as unknown as { clipsyncDesktop?: unknown }).clipsyncDesktop;
      listeners = {};
      receiver = {
        pending: [],
        uploads: [],
        forgotten: [],
        takePending: async () => ({ items: receiver.pending.splice(0) }),
        upload: async (options) => {
          receiver.uploads.push(options);
        },
        forget: async (options) => {
          receiver.forgotten.push(options);
        },
        addListener: async (event, cb) => {
          listeners[event] = cb;
          return {};
        },
      };
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        Plugins: { ShareReceiver: receiver },
      };
    });

    afterEach(() => {
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    });

    it('can send from the phone', () => {
      expect(inject().canSend).toBe(true);
    });

    it('adds shared text as a clipboard item from the phone', async () => {
      inject();
      await flush();
      share({ kind: 'text', text: 'https://example.com/article' });
      await flush();
      expect(addText).toHaveBeenCalledWith('https://example.com/article', { device: 'Phone' });
    });

    it('uploads a shared file natively, encrypted by default', async () => {
      inject();
      await flush();
      share({ kind: 'file', requestId: 'r1', name: 'photo.jpg', sizeBytes: 2000 });
      await flush();
      expect(api.createFile).toHaveBeenCalledWith({
        sizeBytes: encryptedSize(2000),
        encrypted: true,
        name: undefined,
      });
      const upload = receiver.uploads[0] as { requestId: string; key: string };
      expect(upload.requestId).toBe('r1');
      expect(fromBase64(upload.key)).toHaveLength(32);
      expect(addFile).toHaveBeenCalledWith(
        { id: 'fil_1', name: 'photo.jpg', size: 2000, key: upload.key },
        { device: 'Phone' },
      );
    });

    it('drains shares that arrived before the app was ready', async () => {
      receiver.pending = [
        { kind: 'text', text: 'early text' },
        { kind: 'file', requestId: 'r0', name: 'early.pdf', sizeBytes: 10 },
      ];
      inject();
      await flush();
      await flush();
      expect(addText).toHaveBeenCalledWith('early text', { device: 'Phone' });
      expect(addFile).toHaveBeenCalledTimes(1);
    });

    it('keeps shares until the vault is unlocked', async () => {
      status.set('locked');
      inject();
      await flush();
      share({ kind: 'text', text: 'later' });
      share({ kind: 'file', requestId: 'r2', name: 'a.zip', sizeBytes: 5 });
      await flush();
      expect(addText).not.toHaveBeenCalled();
      expect(api.createFile).not.toHaveBeenCalled();

      status.set('unlocked');
      TestBed.tick();
      await flush();
      expect(addText).toHaveBeenCalledWith('later', { device: 'Phone' });
      expect(addFile).toHaveBeenCalledTimes(1);
    });

    it('tells the phone to drop a file whose upload failed', async () => {
      api.createFile.mockRejectedValue(new FileRequestError(502));
      inject();
      await flush();
      share({ kind: 'file', requestId: 'r3', name: 'x.bin', sizeBytes: 5 });
      await flush();
      expect(receiver.forgotten).toEqual([{ requestId: 'r3' }]);
    });
  });
});
