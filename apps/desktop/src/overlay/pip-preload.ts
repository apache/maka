// PiP preload. Receive-only by construction: main owns every frame and every
// coordinate, and the mirror has nothing to report back. Narrower than the
// cursor overlay's preload, which at least acknowledges presentation phases.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('computerUsePip', {
  onFrame: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:frame', (_e, payload) => cb(payload));
  },
  onCursor: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:cursor', (_e, payload) => cb(payload));
  },
});
