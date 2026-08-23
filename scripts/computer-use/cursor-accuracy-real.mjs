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

// Where does the agent cursor actually end up?
//
// The overlay is a transparent, click-through window spanning every display,
// and the cursor is painted into its canvas. Nothing in the product reports
// where the glyph landed, so every claim about it so far has been a claim about
// the code that computes the point, not about the pixel a person sees.
//
// This reads the pixels. It finds the painted cursor in the overlay's canvas,
// converts that back to screen coordinates, and compares it with the target
// control's real rectangle as `ax-oracle.swift` reads it from the system.
// Those two numbers agreeing is the only evidence that the cursor points at
// the thing being clicked.
//
// Run: node scripts/computer-use.mjs cursor-accuracy
import { _electron as electron } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const ORACLE = join(dirname(fileURLToPath(import.meta.url)), 'ax-oracle.swift');
const OUT = '/tmp/cu-cursor-accuracy';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_LABEL = process.env.CU_CURSOR_TARGET ?? '7';
const PROMPT =
  process.env.CU_CURSOR_PROMPT ??
  `用 computer use 观察计算器这个应用，然后依次点一下数字 ${TARGET_LABEL}、加号、数字 3、等号。它在后台，不要切到前台。`;

async function oracle(bundleId) {
  const { stdout } = await exec('swift', [ORACLE, bundleId], {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/**
 * The painted cursor, in the overlay canvas's own CSS pixels.
 *
 * The glyph is the only thing drawn on an otherwise fully transparent canvas,
 * so its centroid is the average position of every pixel with any alpha. An
 * alpha floor keeps the soft shadow from dragging the centre away from the
 * arrow tip.
 */
const CENTROID_IN_PAGE = () => {
  const canvas = document.getElementById('cursor');
  if (!canvas) return { found: false };
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  if (!width || !height) return { found: true, painted: false, reason: 'canvas has no size' };
  const data = ctx.getImageData(0, 0, width, height).data;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Every other pixel in both axes. The glyph is ~30px across, so a stride of
  // two cannot miss it, and a full scan of a 1920×1200 canvas in JS is slow
  // enough to become the sampling interval.
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (data[(y * width + x) * 4 + 3] > 40) {
        sumX += x;
        sumY += y;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count === 0) return { found: true, painted: false };
  const dpr = window.devicePixelRatio || 1;
  return {
    found: true,
    painted: true,
    pixels: count,
    cssX: sumX / count / dpr,
    cssY: sumY / count / dpr,
    tipX: minX / dpr,
    tipY: minY / dpr,
    boxCss: { w: (maxX - minX) / dpr, h: (maxY - minY) / dpr },
  };
};

await mkdir(OUT, { recursive: true });
await exec('osascript', ['-e', 'tell application id "com.apple.calculator" to quit']).catch(
  () => {},
);
await sleep(800);
await exec('open', ['-g', '-a', 'Calculator']).catch(() => {});
await sleep(2000);
// Put the target where Computer Use is actually used: behind the window the
// user is looking at. With the calculator off to one side of the desktop the
// cursor has clear air to be drawn in and the interesting case never happens.
await exec('osascript', [
  '-e',
  'tell application "System Events" to tell (first process whose bundle identifier is "com.apple.calculator") to set position of window 1 to {320, 380}',
]).catch(() => {});
await sleep(800);

const app = await electron.launch({ args: ['.'], cwd: DESKTOP });
const samples = [];
let verdict = [];
let overlaySeen = 0;
let overlayPageMisses = 0;
let blankSamples = 0;
let calls = [];

// The overlay is created on the first action and destroyed with the session,
// which on a short turn is a window narrower than one polling interval. Polling
// missed it entirely on one run and reported "never painted" for what was
// really "never sampled". Listen instead, and sample the page itself.
const overlayPages = [];
// Whether the resting cursor is still pinned above every application window is
// the thing that was reported, and it is only observable while the overlay is
// alive — which on a short turn is narrower than one polling interval. Sampled
// from the window event rather than looked for.
const levelSamples = [];
app.on('window', (opened) => {
  if (!opened.url().includes('cursor-overlay')) return;
  overlayPages.push(opened);
  void (async () => {
    for (let i = 0; i < 120; i += 1) {
      const level = await app
        .evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((win) =>
            win.webContents.getURL().includes('cursor-overlay'),
          );
          return w && !w.isDestroyed() ? { alwaysOnTop: w.isAlwaysOnTop() } : null;
        })
        .catch(() => null);
      if (!level) break;
      levelSamples.push(level.alwaysOnTop);
      await sleep(80);
    }
  })();
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.maka-composer-textarea', { timeout: 60_000 });
  await sleep(1200);

  const newTask = page.getByRole('button', { name: '新任务' });
  if (await newTask.count()) {
    await newTask.first().click();
    await sleep(1000);
  }
  await page.click('.maka-composer-textarea');
  await page.fill('.maka-composer-textarea', PROMPT);
  await page.keyboard.press('Enter');
  console.log(`sent: ${PROMPT}\n`);

  const stopButton = page.getByRole('button', { name: '停止' });
  const deadline = Date.now() + 240_000;
  let started = false;
  while (Date.now() < deadline) {
    if (!started && (await stopButton.count().catch(() => 0)) > 0) started = true;

    // Sample the overlay whenever it exists. It is created on the first action
    // and destroyed with the session, so this has to run inside the turn.
    const overlayBounds = await app
      .evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows().map((w) => ({
          id: w.id,
          url: w.webContents.getURL(),
          bounds: w.getBounds(),
          visible: w.isVisible(),
        }));
        const overlay = all.find((w) => w.url.includes('cursor-overlay'));
        return overlay
          ? {
              ...overlay.bounds,
              id: overlay.id,
              // Everything else on screen that belongs to this app, so a
              // cursor drawn "correctly" can still be shown to be pointing at
              // a window the user cannot see.
              others: all
                .filter((w) => w.id !== overlay.id && w.visible)
                .map((w) => ({
                  id: w.id,
                  kind: w.url.includes('pip') ? 'pip' : 'main',
                  bounds: w.bounds,
                })),
            }
          : null;
      })
      .catch(() => null);
    if (overlayBounds) {
      overlaySeen += 1;
      const overlayPage =
        overlayPages.at(-1) ?? app.windows().find((p) => p.url().includes('cursor-overlay'));
      if (!overlayPage) overlayPageMisses += 1;
      if (overlayPage) {
        const centroid = await overlayPage.evaluate(CENTROID_IN_PAGE).catch(() => null);
        if (centroid?.found && !centroid.painted) blankSamples += 1;
        if (centroid?.painted) {
          samples.push({
            at: Date.now(),
            overlay: overlayBounds,
            screenX: overlayBounds.x + centroid.cssX,
            screenY: overlayBounds.y + centroid.cssY,
            tipScreenX: overlayBounds.x + centroid.tipX,
            tipScreenY: overlayBounds.y + centroid.tipY,
            pixels: centroid.pixels,
            box: centroid.boxCss,
          });
        }
      }
    }
    if (started && (await stopButton.count().catch(() => 0)) === 0) break;
    await sleep(120);
  }
  await sleep(1500);

  // What the machine says the button really is.
  const tree = await oracle('com.apple.calculator');
  const button = (tree.elements ?? []).find(
    (e) => e.role === 'AXButton' && (e.title === TARGET_LABEL || e.description === TARGET_LABEL),
  );
  const window0 = tree.windows?.[0];

  // What the model asked the computer to do, so "the cursor never appeared"
  // can be told apart from "no action ever ran".
  calls = await page
    .evaluate(async () => {
      const sessions = await window.maka.sessions.list();
      if (!sessions[0]) return [];
      const messages = await window.maka.sessions.readMessages(sessions[0].id);
      const results = new Map(
        messages.filter((m) => m.type === 'tool_result').map((m) => [m.toolUseId, m]),
      );
      return messages
        .filter((m) => m.type === 'tool_call' && m.toolName === 'maka_computer')
        .map((m) => {
          const r = results.get(m.id);
          const text =
            typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? '');
          return { action: m.args?.action ?? '?', head: text.replace(/\s+/g, ' ').slice(0, 160) };
        });
    })
    .catch(() => []);
  console.log(`computer calls: ${calls.map((c) => c.action).join(' → ') || '(none)'}`);
  for (const c of calls) console.log(`    ${c.action}: ${c.head}`);
  console.log(
    `overlay existed in ${overlaySeen} samples, page unreachable in ${overlayPageMisses}, blank canvas in ${blankSamples}`,
  );
  console.log(`overlay samples with a painted cursor: ${samples.length}`);
  if (samples.length) {
    const last = samples.at(-1);
    console.log(
      `  last painted at screen (${last.screenX.toFixed(0)}, ${last.screenY.toFixed(0)})`,
    );
    console.log(`  glyph box ${last.box.w.toFixed(0)}x${last.box.h.toFixed(0)}, ${last.pixels} px`);
    console.log(`  overlay window ${JSON.stringify(last.overlay)}`);
  }
  console.log(`calculator window: ${JSON.stringify(window0?.frame)}`);
  console.log(`button "${TARGET_LABEL}": ${JSON.stringify(button?.frame ?? null)}`);

  const last = samples.at(-1);
  if (!last) {
    verdict.push({ label: 'the cursor was painted at all', pass: false, detail: 'never painted' });
  } else if (!button?.frame) {
    verdict.push({
      label: 'the oracle found the target button',
      pass: false,
      detail: 'button not in the accessibility tree',
    });
  } else {
    const cx = button.frame.x + button.frame.w / 2;
    const cy = button.frame.y + button.frame.h / 2;
    const dist = Math.hypot(last.screenX - cx, last.screenY - cy);
    const insideWindow =
      window0 &&
      last.screenX >= window0.frame.x &&
      last.screenX <= window0.frame.x + window0.frame.w &&
      last.screenY >= window0.frame.y &&
      last.screenY <= window0.frame.y + window0.frame.h;
    verdict.push({
      label: 'the cursor landed inside the app window it was driving',
      pass: !!insideWindow,
      detail: `cursor (${last.screenX.toFixed(0)}, ${last.screenY.toFixed(0)}), window ${JSON.stringify(window0?.frame)}`,
    });
    verdict.push({
      label: 'the cursor landed on the button it clicked',
      // The glyph is drawn with its tip at the point, so its centroid sits
      // down-right of the target by roughly half the arrow. A button is ~40pt.
      pass: dist <= 40,
      detail: `${dist.toFixed(0)}pt from the button centre (${cx.toFixed(0)}, ${cy.toFixed(0)})`,
    });

    // Correct coordinates are not the same as a cursor a person can read. If
    // one of this app's own windows covers the point, what the user sees is an
    // arrow floating over a chat transcript, pointing at nothing — while the
    // picture-in-picture mirror right next to it, the window they are actually
    // watching, shows the app being driven with no cursor in it at all.
    const covering = (last.overlay.others ?? []).filter(
      (w) =>
        last.screenX >= w.bounds.x &&
        last.screenX <= w.bounds.x + w.bounds.width &&
        last.screenY >= w.bounds.y &&
        last.screenY <= w.bounds.y + w.bounds.height,
    );
    const pip = (last.overlay.others ?? []).find((w) => w.kind === 'pip');
    // The overlay's own window level, read from the main process. `floating`
    // (3) is above every ordinary application window, which is what made a
    // resting cursor hang over whatever the user was reading. Ordered against
    // the target it should be at normal level (0) instead.
    if (levelSamples.length > 0) {
      verdict.push({
        label: 'the resting cursor came off always-on-top at least once',
        pass: levelSamples.some((onTop) => onTop === false),
        detail: `${levelSamples.filter((t) => t === false).length}/${levelSamples.length} samples off always-on-top`,
      });
    }
    verdict.push({
      label: 'the cursor is drawn somewhere the user can connect to the target',
      pass: covering.length === 0,
      detail:
        covering.length === 0
          ? 'nothing of ours covers the point'
          : `covered by ${covering.map((w) => `${w.kind} ${JSON.stringify(w.bounds)}`).join(', ')}` +
            (pip ? `; the mirror the user is watching is at ${JSON.stringify(pip.bounds)}` : ''),
    });
  }
} catch (error) {
  console.log(`[ERROR] ${error?.stack ?? error}`);
  verdict.push({ label: 'the probe ran', pass: false, detail: String(error?.message ?? error) });
} finally {
  await app.close().catch(() => {});
}

await writeFile(join(OUT, 'samples.json'), JSON.stringify(samples, null, 2), 'utf8');
console.log('');
for (const v of verdict) console.log(`[${v.pass ? 'PASS' : 'FAIL'}] ${v.label} — ${v.detail}`);
process.exit(verdict.every((v) => v.pass) ? 0 : 1);
