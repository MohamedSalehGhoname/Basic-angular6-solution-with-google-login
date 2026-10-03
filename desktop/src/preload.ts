import { contextBridge, ipcRenderer } from 'electron';

export type CapturedPayload =
  | { kind: 'text'; text: string; potentialSecret: boolean }
  | { kind: 'image'; image: string };

/** A clipboard entry preview pushed to the compact picker overlay. */
export interface PickerItem {
  id: string;
  kind: 'text' | 'image';
  preview: string;
}

export interface FileSendRequest {
  requestId: string;
  name: string;
  sizeBytes: number;
}

/** Bytes moved so far for an upload (request id) or download (caller's id). */
export interface FileProgress {
  id: string;
  done: number;
  total: number;
}

/**
 * The only surface the renderer (the web app) can see. contextIsolation keeps
 * Node out of the page; captured clipboard text arrives here and the renderer
 * encrypts and syncs it through its existing vault code.
 */
const api = {
  isDesktop: true as const,
  onCaptured(callback: (payload: CapturedPayload) => void): () => void {
    const listener = (_event: unknown, payload: CapturedPayload) => callback(payload);
    ipcRenderer.on('clipsync:captured', listener);
    return () => ipcRenderer.removeListener('clipsync:captured', listener);
  },
  onToggleCaptureRequested(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on('clipsync:request-toggle-capture', listener);
    return () => ipcRenderer.removeListener('clipsync:request-toggle-capture', listener);
  },
  /** Push the current clipboard previews to the picker overlay. */
  updatePickerItems(items: PickerItem[]): void {
    ipcRenderer.send('clipsync:update-picker', items);
  },
  /** The overlay asked to copy this item id; do it via the normal copy path. */
  onPickerCopy(callback: (id: string) => void): () => void {
    const listener = (_event: unknown, id: string) => callback(id);
    ipcRenderer.on('clipsync:picker-copy', listener);
    return () => ipcRenderer.removeListener('clipsync:picker-copy', listener);
  },
  /**
   * Write to the OS clipboard from the main process. The browser Clipboard API
   * needs the document focused, which the hidden main window is not when the
   * picker overlay drives a copy — so route the decrypted value here instead.
   */
  writeClipboard(payload: { text?: string; image?: string; paste?: boolean }): void {
    ipcRenderer.send('clipsync:write-clipboard', payload);
  },
  /**
   * Files sent from Explorer's right-click menu. Returns the ones that arrived
   * before this call; later ones come through the callback. The renderer
   * never sees a path — only a request id, the file name and its size.
   */
  async onFileSend(callback: (request: FileSendRequest) => void): Promise<() => void> {
    const listener = (_event: unknown, request: FileSendRequest) => callback(request);
    ipcRenderer.on('clipsync:file-send', listener);
    const pending = (await ipcRenderer.invoke('clipsync:take-file-sends')) as FileSendRequest[];
    pending.forEach(callback);
    return () => ipcRenderer.removeListener('clipsync:file-send', listener);
  },
  /** Streams a sent file to its storage URL, encrypting with `key` (base64) if given. */
  uploadFile(requestId: string, uploadUrl: string, key: string | null): Promise<void> {
    return ipcRenderer.invoke('clipsync:upload-file', { requestId, uploadUrl, key });
  },
  /** Drops a sent file the renderer will not upload. */
  forgetFile(requestId: string): void {
    ipcRenderer.send('clipsync:forget-file', requestId);
  },
  /** Downloads (and decrypts, given a key) into Downloads; resolves to the saved path. */
  downloadFile(args: {
    id: string;
    downloadUrl: string;
    name: string;
    key: string | null;
  }): Promise<string> {
    return ipcRenderer.invoke('clipsync:download-file', args);
  },
  onFileProgress(callback: (progress: FileProgress) => void): () => void {
    const listener = (_event: unknown, progress: FileProgress) => callback(progress);
    ipcRenderer.on('clipsync:file-progress', listener);
    return () => ipcRenderer.removeListener('clipsync:file-progress', listener);
  },
  showWindow(): void {
    ipcRenderer.send('clipsync:show-window');
  },
  setCaptureEnabled(enabled: boolean): void {
    ipcRenderer.send('clipsync:set-enabled', enabled);
  },
  setCaptureSecrets(enabled: boolean): void {
    ipcRenderer.send('clipsync:set-capture-secrets', enabled);
  },
};

export type ClipsyncDesktopApi = typeof api;

contextBridge.exposeInMainWorld('clipsyncDesktop', api);
