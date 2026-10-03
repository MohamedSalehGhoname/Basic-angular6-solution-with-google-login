import { contextBridge, ipcRenderer } from 'electron';

export interface PickerItem {
  id: string;
  kind: 'text' | 'image';
  /** Text preview, or an image data URL for image items. */
  preview: string;
}

/** The API the compact picker overlay talks to; no vault key ever crosses it. */
const api = {
  onItems(callback: (items: PickerItem[]) => void): void {
    ipcRenderer.on('picker:items', (_event, items: PickerItem[]) => callback(items));
  },
  pick(id: string): void {
    ipcRenderer.send('picker:pick', id);
  },
  close(): void {
    ipcRenderer.send('picker:close');
  },
};

contextBridge.exposeInMainWorld('picker', api);
