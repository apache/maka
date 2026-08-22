#!/usr/bin/env node
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

// Real-window smoke for the picture-in-picture mirror's interaction.
//
// The unit tests drive a fake window, so they prove the physics and the state
// machine and nothing about Electron. This runs the real thing: a real parent
// window, a real child panel, the real preload and renderer, and real input
// events delivered to the page. Everything it asserts is something that was
// either measured on this machine or read out of Codex's binary.
//
// Run: npm --workspace @maka/desktop run build:main && npm --workspace @maka/desktop run build:overlay
//      && npx electron scripts/pip-interaction-smoke.mjs
import { app, BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'apps', 'desktop', 'dist');
const { createComputerUsePipController } = await import(
  join(dist, 'main', 'computer-use', 'pip-window.js')
);

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the mirror stops moving, so assertions never race the spring.
 *
 * Requires several identical samples rather than two: the settle is
 * overdamped, so its last stretch moves less than a point per frame and two
 * consecutive reads can round to the same value while it is still travelling.
 * Two was enough to report the mirror had arrived a point short of the anchor.
 */
async function settled(win, timeoutMs = 4000) {
  let last = null;
  let same = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bounds = win.getBounds();
    if (last && bounds.x === last.x && bounds.y === last.y) {
      if (++same >= 6) return bounds;
    } else {
      same = 0;
    }
    last = bounds;
    await sleep(60);
  }
  return win.getBounds();
}

app.whenReady().then(async () => {
  const parent = new BrowserWindow({ x: 120, y: 120, width: 1000, height: 700, show: true });
  await parent.loadURL('data:text/html,<body style="background:%23202028"></body>');
  await sleep(300);

  // The pointer the drag reads. Driven from here so the gesture is exact
  // rather than dependent on whatever the real mouse happens to be doing.
  let pointer = { x: 0, y: 0 };
  let pip = null;
  const created = [];

  pip = createComputerUsePipController({
    resolveAnchorRect: () => parent.getBounds(),
    subscribeAnchorChanges: (cb) => {
      parent.on('move', cb);
      parent.on('resize', cb);
      return () => {
        parent.off('move', cb);
        parent.off('resize', cb);
      };
    },
    resolveParentWindow: () => parent,
    cursorPoint: () => pointer,
    workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
    preloadPath: join(dist, 'overlay', 'pip-preload.cjs'),
    htmlPath: join(dist, 'overlay', 'pip.html'),
  });

  pip.present({
    sessionId: 'smoke',
    base64: PNG_1X1,
    mimeType: 'image/png',
    widthPx: 1000,
    heightPx: 800,
  });
  await sleep(900);

  const mirror = BrowserWindow.getAllWindows().find((w) => w !== parent);
  if (!mirror) {
    console.log('the mirror never opened; stopping.');
    app.exit(2);
    return;
  }
  created.push(mirror);

  // ── the two properties the child-window fix bought ────────────────────────
  check('the mirror does not float above other apps', mirror.isAlwaysOnTop() === false);
  // `parent.isFocused()` is about the whole app being frontmost, which a
  // headless-ish run cannot promise. What the mirror owes is narrower: it must
  // never be the focused window itself.
  check('the mirror never took focus', mirror.isFocused() === false);
  check('the mirror is the app window’s child', mirror.getParentWindow() === parent);

  const seated = mirror.getBounds();
  const app0 = parent.getBounds();
  check(
    'it is seated on the app window’s bottom-right, inset 24pt',
    seated.x === app0.x + app0.width - seated.width - 24 &&
      seated.y === app0.y + app0.height - seated.height - 24,
    `${JSON.stringify(seated)} against ${JSON.stringify(app0)}`,
  );

  // ── a pure move is carried by the window server, not by us ────────────────
  parent.setBounds({ ...app0, x: app0.x + 160 });
  await sleep(400);
  check(
    'moving the app carries the mirror with it',
    mirror.getBounds().x === seated.x + 160,
    `${seated.x} → ${mirror.getBounds().x}`,
  );

  // ── click-through until pointed at ────────────────────────────────────────
  const contents = mirror.webContents;
  const inMirror = (dx, dy) => ({ x: dx, y: dy });
  // Hover is decided from the real pointer on the main side, so the test moves
  // the pointer rather than injecting a page event.
  const mid = mirror.getBounds();
  pointer = { x: mid.x + 40, y: mid.y + 40 };
  await sleep(300);
  const hovered = await contents.executeJavaScript(
    "document.getElementById('controls').dataset.visible",
  );
  check('the controls appear on hover', hovered === '1', `data-visible=${hovered}`);

  // ── throw it at the opposite corner ───────────────────────────────────────
  const before = mirror.getBounds();
  // Press in the middle of the tile, clear of both the controls (top-right,
  // 20x20 inset 8) and the resize grip (20x20 inset 8, on whichever corner is
  // opposite the anchor). This used to press at (20, 20), which is inside the
  // grip's 8..28 box: the grip stops the event propagating, so no drag ever
  // started, the moves ran as a resize instead, and the five checks after it
  // failed on the cascade. This half of the script had never completed.
  const GRAB = { x: Math.round(before.width / 2), y: Math.round(before.height / 2) };
  pointer = { x: before.x + GRAB.x, y: before.y + GRAB.y };
  contents.sendInputEvent({
    type: 'mouseDown',
    ...inMirror(GRAB.x, GRAB.y),
    button: 'left',
    clickCount: 1,
  });
  await sleep(60);
  const appNow = parent.getBounds();
  // Three samples so the tracker sees real motion, ending fast enough that the
  // release reads as a throw rather than a place.
  for (const [fx, fy] of [
    [0.7, 0.7],
    [0.4, 0.4],
    [0.22, 0.18],
  ]) {
    pointer = { x: appNow.x + appNow.width * fx, y: appNow.y + appNow.height * fy };
    contents.sendInputEvent({ type: 'mouseMove', ...inMirror(GRAB.x, GRAB.y) });
    await sleep(30);
  }
  contents.sendInputEvent({
    type: 'mouseUp',
    ...inMirror(GRAB.x, GRAB.y),
    button: 'left',
    clickCount: 1,
  });

  const landed = await settled(mirror);
  check(
    'thrown up and left, it settles on the top-left anchor',
    landed.x === appNow.x + 24 && landed.y === appNow.y + 24,
    `${JSON.stringify(landed)} against app ${JSON.stringify(appNow)}`,
  );
  check(
    'and the controller agrees which corner that is',
    pip.currentAlignment() === 'top-left',
    pip.currentAlignment(),
  );

  // ── a resize returns it to the corner the user chose ──────────────────────
  parent.setBounds({ ...appNow, width: appNow.width - 200, height: appNow.height - 120 });
  await sleep(500);
  const afterResize = mirror.getBounds();
  const appResized = parent.getBounds();
  check(
    'a resize keeps it on the chosen corner, not the default one',
    afterResize.x === appResized.x + 24 && afterResize.y === appResized.y + 24,
    JSON.stringify(afterResize),
  );

  // ── the grip resizes it, away from whichever corner it rests on ──────────
  const beforeGrip = mirror.getBounds();
  const gripAt = await contents.executeJavaScript(
    "(() => { const r = document.getElementById('resize').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
  );
  // The tile is anchored top-left, so its top-left corner is the one held
  // still and the grip has to be on the bottom-right — the corner that moves.
  // Pinning the grip to the tile's top-left, which is what the CSS did before
  // main started sending the alignment down, put the handle on the corner the
  // gesture holds: the pointer left it on the first pixel of the drag.
  check(
    'the grip sits on the corner opposite the anchor',
    gripAt.x > beforeGrip.width / 2 && gripAt.y > beforeGrip.height / 2,
    `grip at ${JSON.stringify(gripAt)} in a ${beforeGrip.width}x${beforeGrip.height} tile ` +
      `anchored ${pip.currentAlignment()}`,
  );
  pointer = { x: beforeGrip.x + gripAt.x, y: beforeGrip.y + gripAt.y };
  contents.sendInputEvent({ type: 'mouseMove', ...gripAt });
  await sleep(150);
  contents.sendInputEvent({ type: 'mouseDown', ...gripAt, button: 'left', clickCount: 1 });
  await sleep(60);
  // Anchored top-left, so the grip is below the anchor and dragging down grows.
  for (const dy of [30, 60, 90]) {
    pointer = { x: pointer.x, y: beforeGrip.y + gripAt.y + dy };
    contents.sendInputEvent({ type: 'mouseMove', ...gripAt });
    await sleep(60);
  }
  contents.sendInputEvent({ type: 'mouseUp', ...gripAt, button: 'left', clickCount: 1 });
  await sleep(300);
  const afterGrip = mirror.getBounds();
  const grew =
    Math.max(afterGrip.width, afterGrip.height) > Math.max(beforeGrip.width, beforeGrip.height);
  check(
    'dragging the grip away from the anchor grows the mirror',
    grew,
    `${beforeGrip.width}x${beforeGrip.height} → ${afterGrip.width}x${afterGrip.height}`,
  );
  check(
    'and it stays inside Codex’s [100, 400] clamp',
    Math.max(afterGrip.width, afterGrip.height) <= 400 &&
      Math.min(afterGrip.width, afterGrip.height) >= 1,
    `${afterGrip.width}x${afterGrip.height}`,
  );
  check(
    'and it is still on the corner it was resting on',
    afterGrip.x === appResized.x + 24 && afterGrip.y === appResized.y + 24,
    JSON.stringify(afterGrip),
  );

  // ── hide dismisses it ─────────────────────────────────────────────────────
  //
  // The controls are click-through until the *main-side* pointer says the
  // pointer is on the mirror — that is the whole point of the hover poll — so
  // the fixture has to move its pointer as well as send the page event. It
  // did not, and the grip drag happened to leave the pointer one point past
  // the tile's bottom edge, so the window was still ignoring mouse events and
  // the controls still had `pointer-events: none` when the click arrived.
  const tile = mirror.getBounds();
  pointer = { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
  await sleep(200);
  const visibleNow = await contents.executeJavaScript(
    "document.getElementById('controls').dataset.visible",
  );
  check('the controls are on before the click', visibleNow === '1', `data-visible=${visibleNow}`);
  const hideAt = await contents.executeJavaScript(
    '(() => { const b = document.querySelector(\'[data-control="hide"]\'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()',
  );
  pointer = { x: tile.x + hideAt.x, y: tile.y + hideAt.y };
  contents.sendInputEvent({ type: 'mouseMove', ...hideAt });
  await sleep(120);
  contents.sendInputEvent({ type: 'mouseDown', ...hideAt, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...hideAt, button: 'left', clickCount: 1 });
  await sleep(400);
  check('the hide control dismisses the mirror', pip.isVisible() === false);

  pip.destroyAll();
  for (const w of created) if (!w.isDestroyed()) w.destroy();
  parent.destroy();
  console.log(failures === 0 ? '\nPIP INTERACTION OK' : `\n${failures} check(s) failed`);
  app.exit(failures === 0 ? 0 : 1);
});
