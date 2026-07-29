// PiP renderer. Receives frames and cursor positions from main and draws them;
// it computes nothing about the target and reports nothing back.
declare global {
  interface Window {
    computerUsePip: {
      onFrame(cb: (payload: unknown) => void): void;
      onCursor(cb: (payload: unknown) => void): void;
    };
  }
}

const frame = document.getElementById('frame') as HTMLImageElement;
const cursor = document.getElementById('cursor') as HTMLDivElement;

/** Size of the captured frame, needed to place the cursor within it. */
let capture = { widthPx: 0, heightPx: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The mirrored image is letterboxed by `object-fit: contain`, so the cursor's
 * position in capture pixels is not the same as its position in the element.
 * Recover the drawn rectangle before placing it, or the dot drifts away from
 * what it is pointing at whenever the aspect ratios differ.
 */
function drawnRect(): { x: number; y: number; width: number; height: number } | null {
  if (capture.widthPx <= 0 || capture.heightPx <= 0) return null;
  const boxW = frame.clientWidth;
  const boxH = frame.clientHeight;
  if (boxW <= 0 || boxH <= 0) return null;
  const scale = Math.min(boxW / capture.widthPx, boxH / capture.heightPx);
  const width = capture.widthPx * scale;
  const height = capture.heightPx * scale;
  return { x: (boxW - width) / 2, y: (boxH - height) / 2, width, height };
}

window.computerUsePip.onFrame((payload) => {
  if (!isRecord(payload)) return;
  const src = typeof payload.src === 'string' ? payload.src : '';
  if (!src) return;
  const widthPx = typeof payload.widthPx === 'number' ? payload.widthPx : 0;
  const heightPx = typeof payload.heightPx === 'number' ? payload.heightPx : 0;
  capture = { widthPx, heightPx };
  frame.src = src;
  // Keep the cursor dot proportional to the mirror. Codex's tile defaults to a
  // 200pt longest edge, where a fixed 11px dot covers 5.5% of the surface.
  const shorter = Math.min(frame.clientWidth || 0, frame.clientHeight || 0);
  if (shorter > 0) {
    cursor.style.setProperty('--dot', `${Math.max(5, Math.min(11, shorter * 0.055))}px`);
  }
});

window.computerUsePip.onCursor((payload) => {
  if (!isRecord(payload)) {
    cursor.dataset.visible = '0';
    return;
  }
  if (payload.hidden === true) {
    cursor.dataset.visible = '0';
    return;
  }
  const x = typeof payload.x === 'number' ? payload.x : null;
  const y = typeof payload.y === 'number' ? payload.y : null;
  const rect = drawnRect();
  if (x === null || y === null || !rect) {
    cursor.dataset.visible = '0';
    return;
  }
  cursor.style.left = `${rect.x + (x / capture.widthPx) * rect.width}px`;
  cursor.style.top = `${rect.y + (y / capture.heightPx) * rect.height}px`;
  cursor.dataset.visible = '1';
});

export {};
