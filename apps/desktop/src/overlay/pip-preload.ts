// PiP preload. Frames and the cursor come down; pointer and controls go up.
//
// It was receive-only before this, because the mirror did nothing. Now it is
// draggable and carries two controls, and the page is the only thing that can
// see the pointer: the window is click-through with `forward: true`, so moves
// reach the page while clicks pass through to whatever is underneath, and the
// page is what tells main when to take the clicks back.
import { contextBridge, ipcRenderer } from 'electron';

// An allow-list rather than a pass-through. The bridge is the boundary, and a
// boundary that forwards whatever channel name it is handed is not one.
const SEND_CHANNELS = new Set([
  'pip:pointer-down',
  'pip:pointer-move',
  'pip:pointer-up',
  'pip:control',
  'pip:resize-begin',
  'pip:resize-move',
  'pip:resize-end',
]);

contextBridge.exposeInMainWorld('computerUsePip', {
  onFrame: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:frame', (_e, payload) => cb(payload));
  },
  onCursor: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:cursor', (_e, payload) => cb(payload));
  },
  onControls: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:controls', (_e, payload) => cb(payload));
  },
  onLayout: (cb: (p: unknown) => void): void => {
    ipcRenderer.on('pip:layout', (_e, payload) => cb(payload));
  },
  onCompleted: (cb: () => void): void => {
    ipcRenderer.on('pip:completed', () => cb());
  },
  send: (channel: string, payload?: unknown): void => {
    if (!SEND_CHANNELS.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
});
