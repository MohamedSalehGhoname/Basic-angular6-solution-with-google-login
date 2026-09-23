import type { FileProgress, FileSendRequest } from './desktop-capture.service';

/**
 * A native shell that can hand files (and, on phones, text) to the app and
 * upload them. The bytes never enter the web app: it gets ids, names and
 * sizes, asks the sync server for a storage URL, and tells the shell to
 * upload (encrypting with the key it passes, if any).
 */
export interface FileSender {
  /** Shown on the resulting clipboard items. */
  readonly device: string;
  start(handlers: {
    file: (request: FileSendRequest) => void;
    text: (text: string) => void;
    progress: (progress: FileProgress) => void;
  }): void;
  upload(requestId: string, uploadUrl: string, key: string | null): Promise<void>;
  forget(requestId: string): void;
  /** Bring the app forward, e.g. to ask for an unlock. */
  reveal?(): void;
}

/** The Electron app: files from Explorer's "Send to" menu. */
export function desktopSender(): FileSender | null {
  const desktop = window.clipsyncDesktop;
  if (!desktop?.onFileSend || !desktop.uploadFile) {
    return null;
  }
  return {
    device: 'Desktop',
    start: (handlers) => {
      desktop.onFileProgress?.(handlers.progress);
      void desktop.onFileSend!(handlers.file);
    },
    upload: (requestId, uploadUrl, key) => desktop.uploadFile!(requestId, uploadUrl, key),
    forget: (requestId) => desktop.forgetFile?.(requestId),
    reveal: () => desktop.showWindow?.(),
  };
}

type ShareItem =
  | { kind: 'text'; text: string }
  | { kind: 'file'; requestId: string; name: string; sizeBytes: number };

/** The ShareReceiver Capacitor plugin (mobile/plugins/share-receiver). */
interface ShareReceiverPlugin {
  takePending(): Promise<{ items: ShareItem[] }>;
  upload(options: { requestId: string; uploadUrl: string; key: string | null }): Promise<void>;
  forget(options: { requestId: string }): Promise<void>;
  addListener(event: 'share', callback: (item: ShareItem) => void): Promise<unknown>;
  addListener(event: 'progress', callback: (progress: FileProgress) => void): Promise<unknown>;
}

/** The Android app: anything shared to "Clipboard Sync" from another app. */
export function mobileSender(): FileSender | null {
  const plugin = (
    window as unknown as { Capacitor?: { Plugins?: { ShareReceiver?: ShareReceiverPlugin } } }
  ).Capacitor?.Plugins?.ShareReceiver;
  if (!plugin) {
    return null;
  }
  return {
    device: 'Phone',
    start: (handlers) => {
      const dispatch = (item: ShareItem) => {
        if (item.kind === 'text') {
          handlers.text(item.text);
        } else {
          handlers.file({ requestId: item.requestId, name: item.name, sizeBytes: item.sizeBytes });
        }
      };
      void (async () => {
        // Listen first, then drain what arrived before the app was ready.
        await plugin.addListener('share', dispatch);
        await plugin.addListener('progress', handlers.progress);
        const { items } = await plugin.takePending();
        items.forEach(dispatch);
      })();
    },
    upload: (requestId, uploadUrl, key) => plugin.upload({ requestId, uploadUrl, key }),
    forget: (requestId) => void plugin.forget({ requestId }),
  };
}
