/**
 * Permission-overlay preload.
 *
 * Narrower than it looks: the card may only announce three fixed
 * intentions (the user grabbed the row, dismissed the card, or asked to
 * be shown the bundle), and may only receive two. It never passes a file
 * path — main resolves the `.app` itself, so a compromised overlay page
 * cannot talk main into dragging an arbitrary file into a TCC list.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('permissionOverlay', {
  onShow: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on('permission-overlay:show', (_e, payload) => cb(payload));
  },
  onGranted: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on('permission-overlay:granted', (_e, payload) => cb(payload));
  },
  /** `iconDataUrl` is only ever a drag image; the dragged file is main's. */
  startDrag: (iconDataUrl: string | null): void => {
    ipcRenderer.send('permission-overlay:start-drag', {
      iconDataUrl: typeof iconDataUrl === 'string' ? iconDataUrl : null,
    });
  },
  dismiss: (): void => {
    ipcRenderer.send('permission-overlay:dismiss');
  },
  revealBundle: (): void => {
    ipcRenderer.send('permission-overlay:reveal-bundle');
  },
});
