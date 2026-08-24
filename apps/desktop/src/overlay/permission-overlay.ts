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

/**
 * Permission-overlay card (renderer half).
 *
 * Main owns everything consequential — which permission, which bundle,
 * when to close. This script paints the card and reports three gestures.
 *
 * The drag starts on `mousedown`, not `dragstart`: an HTML5 drag never
 * leaves our process, so System Settings would never see it. Main takes
 * over from the live mouse event via `webContents.startDrag`, which is
 * why the gesture feels continuous to the user — they press and keep
 * moving, and the OS drag session picks up mid-motion.
 */

interface OverlayCopy {
  headline: string;
  fallback: string;
  granted: string;
  dismiss: string;
  dragHint: string;
  restartHint: string | null;
  noBundle: string;
}

interface ShowPayload {
  permission: string;
  appName: string;
  iconDataUrl: string | null;
  draggable: boolean;
  copy: OverlayCopy;
}

declare global {
  interface Window {
    permissionOverlay: {
      onShow(cb: (payload: unknown) => void): void;
      onGranted(cb: (payload: unknown) => void): void;
      startDrag(iconDataUrl: string | null): void;
      dismiss(): void;
      revealBundle(): void;
    };
  }
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const row = el<HTMLDivElement>('row');
const icon = el<HTMLImageElement>('icon');
const name = el<HTMLSpanElement>('name');
const hint = el<HTMLSpanElement>('hint');
const headline = el<HTMLDivElement>('headline');
const sub = el<HTMLDivElement>('sub');
const close = el<HTMLButtonElement>('close');

let current: ShowPayload | null = null;

function isShowPayload(value: unknown): value is ShowPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.appName === 'string' && typeof v.copy === 'object' && v.copy !== null;
}

/**
 * Paint the drag image: a 200x44 replica of the row the user is about to
 * drop into, drawn at device resolution so it is not soft on Retina.
 * Handing macOS the raw app icon would be easier but weaker — the point
 * is that what you drag already looks like what it becomes.
 */
function rowAsDragImage(): string | null {
  if (!current) return null;
  const scale = Math.max(2, window.devicePixelRatio || 1);
  const width = 200;
  const height = 44;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (icon.complete && icon.naturalWidth > 0) {
    ctx.drawImage(icon, 10, 8, 28, 28);
  }
  ctx.fillStyle = '#1d1d1f';
  ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(current.appName, 46, height / 2);

  return canvas.toDataURL('image/png');
}

window.permissionOverlay.onShow((payload) => {
  if (!isShowPayload(payload)) return;
  current = payload;
  name.textContent = payload.appName;
  headline.textContent = payload.copy.headline;
  hint.textContent = payload.copy.dragHint;
  close.setAttribute('aria-label', payload.copy.dismiss);
  row.dataset.draggable = payload.draggable ? 'true' : 'false';

  if (payload.iconDataUrl) icon.src = payload.iconDataUrl;

  // The manual route is always shown: the drag is a shortcut, never the
  // only way through. When there is no bundle to drag it is the only way.
  sub.textContent = payload.draggable
    ? [payload.copy.fallback, payload.copy.restartHint].filter(Boolean).join(' ')
    : payload.copy.noBundle;
});

window.permissionOverlay.onGranted(() => {
  if (current) headline.textContent = current.copy.granted;
  document.body.dataset.granted = 'true';
});

row.addEventListener('mousedown', (event) => {
  if (!current) return;
  event.preventDefault();
  if (!current.draggable) {
    // Nothing draggable — put the user in front of the bundle in Finder
    // rather than letting the gesture die silently.
    window.permissionOverlay.revealBundle();
    return;
  }
  window.permissionOverlay.startDrag(rowAsDragImage());
});

close.addEventListener('click', () => {
  window.permissionOverlay.dismiss();
});

export {};
