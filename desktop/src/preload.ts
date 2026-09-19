import { contextBridge, ipcRenderer } from 'electron';

export interface CapturedPayload {
  text: string;
  potentialSecret: boolean;
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
  setCaptureEnabled(enabled: boolean): void {
    ipcRenderer.send('clipsync:set-enabled', enabled);
  },
  setCaptureSecrets(enabled: boolean): void {
    ipcRenderer.send('clipsync:set-capture-secrets', enabled);
  },
};

export type ClipsyncDesktopApi = typeof api;

contextBridge.exposeInMainWorld('clipsyncDesktop', api);
