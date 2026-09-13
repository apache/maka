/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// PiP renderer. Receives frames and cursor positions from main and draws them;
// it computes nothing about the target. It does report the pointer, because
// only the page can see it — main moves the window, the page says when.
declare global {
  interface Window {
    computerUsePip: {
      onFrame(cb: (payload: unknown) => void): void;
      onCursor(cb: (payload: unknown) => void): void;
      onControls(cb: (payload: unknown) => void): void;
      onLayout(cb: (payload: unknown) => void): void;
      onCompleted(cb: () => void): void;
      send(channel: string, payload?: unknown): void;
    };
  }
}

const frame = document.getElementById('frame') as HTMLImageElement;
const cursor = document.getElementById('cursor') as HTMLDivElement;
const placeholder = document.getElementById('placeholder') as HTMLDivElement;
const chrome = document.getElementById('chrome') as HTMLDivElement;
const controls = document.getElementById('controls') as HTMLDivElement;
const resize = document.getElementById('resize') as HTMLDivElement;

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
  // The mirror is streaming, so the loading placeholder has done its job. It
  // is only ever taken down, never put back: a stream that stalls mid-run
  // should hold the last frame, not claim to be starting again.
  placeholder.dataset.visible = '0';
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

// ── pointer ──────────────────────────────────────────────────────────────────
//
// Hover is main's decision, not the page's. Main tracks the pointer directly,
// the way Codex tracks it with `addGlobalMonitorForEventsMatchingMask:` feeding
// `updateHoverFromCurrentMouseLocation` rather than asking its window whether
// the pointer is inside — and main takes the clicks back for exactly as long as
// the pointer is on the mirror. Letting the page decide meant relying on moves
// forwarded to a click-through window, and those were measured dropping events
// on this machine.

let dragging = false;

window.computerUsePip.onControls((payload) => {
  const visible = isRecord(payload) && payload.visible === true ? '1' : '0';
  controls.dataset.visible = visible;
  chrome.dataset.visible = visible;
  resize.dataset.visible = visible;
});

/**
 * Which corner the grip belongs on.
 *
 * Main decides, because main is what knows the anchor: the tile grows away
 * from the corner it is pinned to, so the handle has to be on the corner that
 * actually moves. The CSS used to pin it to the tile's top-left, which is only
 * right for the default bottom-right anchor — in the other three the pointer
 * came off the grip immediately, because the grip was sitting on the one
 * corner the gesture holds still.
 */
const GRIP_CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

window.computerUsePip.onLayout((payload) => {
  if (!isRecord(payload)) return;
  const corner = payload.gripCorner;
  if (typeof corner !== 'string' || !GRIP_CORNERS.has(corner)) return;
  document.body.dataset.grip = corner;
});

document.addEventListener('mousemove', () => {
  if (dragging) window.computerUsePip.send('pip:pointer-move');
});

let resizing = false;

resize.addEventListener('mousedown', (event) => {
  // The grip owns the press; the tile's drag must not also start.
  event.stopPropagation();
  resizing = true;
  window.computerUsePip.send('pip:resize-begin');
});

document.addEventListener('mousemove', () => {
  if (resizing) window.computerUsePip.send('pip:resize-move');
});

for (const event of ['mouseup', 'blur'] as const) {
  window.addEventListener(event, () => {
    if (!resizing) return;
    resizing = false;
    window.computerUsePip.send('pip:resize-end');
  });
}

document.addEventListener('mousedown', (event) => {
  // The controls are buttons; let them be pressed rather than starting a drag
  // that happens to begin on top of one.
  if ((event.target as HTMLElement | null)?.closest('[data-control]')) return;
  dragging = true;
  document.body.dataset.dragging = '1';
  window.computerUsePip.send('pip:pointer-down');
});

for (const event of ['mouseup', 'blur'] as const) {
  window.addEventListener(event, () => {
    if (!dragging) return;
    dragging = false;
    delete document.body.dataset.dragging;
    window.computerUsePip.send('pip:pointer-up');
  });
}

controls.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement | null)?.closest('[data-control]');
  const id = button instanceof HTMLElement ? button.dataset.control : null;
  if (!id) return;
  window.computerUsePip.send('pip:control', { id });
});

export {};

// The run finished. The mirror stays up for a while so the last state can be
// read; this is the only sign that what it shows has stopped changing.
window.computerUsePip.onCompleted(() => {
  cursor.style.display = 'none';
  document.body.classList.add('pipCompleted');
});
