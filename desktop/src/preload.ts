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
  writeClipboard(payload: { text?: string; image?: string }): void {
    ipcRenderer.send('clipsync:write-clipboard', payload);
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
