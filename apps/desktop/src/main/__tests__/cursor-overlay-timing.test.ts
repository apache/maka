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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  CURSOR_CLOSE_ENOUGH,
  CursorEngine,
  cursorPresentationReadyDeadlineMs,
} from '../../renderer/computer-use-overlay/engine/cursor-engine.js';

type MovePayload = {
  actionId: string;
  x: number;
  y: number;
  instant?: boolean;
};

type CompletePayload = {
  actionId?: string;
  x: number;
  y: number;
};

type ResetPayload = { sessionId: string; generation: number };

type FrameCallback = (now: number) => void;

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function cursorOverlayBundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(desktopRoot, 'src', 'overlay', 'cursor-overlay.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'js-to-ts',
      setup(bundle) {
        bundle.onResolve({ filter: /^\.\.?\/.*\.js$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts')),
        }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

async function makeOverlayHarness() {
  let nowMs = 0;
  const frames: FrameCallback[] = [];
  const reports: Array<{
    sessionId: string;
    generation: number;
    actionId: string;
    phase: string;
    atMs: number;
  }> = [];
  const translations: Array<readonly [number, number]> = [];
  let onMove: ((payload: MovePayload) => void) | undefined;
  let onComplete: ((payload: CompletePayload) => void) | undefined;
  let onReset: ((payload: ResetPayload) => void) | undefined;

  const gradient = { addColorStop() {} };
  const context2d = {
    setTransform() {},
    clearRect() {},
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    closePath() {},
    save() {},
    restore() {},
    translate(x: number, y: number) { translations.push([x, y]); },
    rotate() {},
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(_value: number) {},
  };
  const canvas = {
    width: 0,
    height: 0,
    style: { width: '', height: '' },
    getContext: () => context2d,
  };
  const windowObject = {
    devicePixelRatio: 1,
    innerWidth: 3840,
    innerHeight: 1600,
    addEventListener() {},
    cursorOverlay: {
      onMove(callback: (payload: MovePayload) => void) { onMove = callback; },
      onComplete(callback: (payload: CompletePayload) => void) { onComplete = callback; },
      onCancel() {},
      onReset(callback: (payload: ResetPayload) => void) { onReset = callback; },
      reportPresentationPhase(
        sessionId: string,
        generation: number,
        actionId: string,
        phase: string,
      ) {
        reports.push({ sessionId, generation, actionId, phase, atMs: nowMs });
      },
    },
  };
  const sandbox = {
    window: windowObject,
    document: { getElementById: () => canvas },
    performance: { now: () => nowMs },
    requestAnimationFrame(callback: FrameCallback) {
      frames.push(callback);
      return frames.length;
    },
  };
  vm.runInNewContext(await cursorOverlayBundle(), sandbox);
  assert.ok(onMove && onComplete, 'overlay registered its bridge callbacks');

  return {
    reports,
    translations,
    move(payload: MovePayload, atMs: number) {
      nowMs = atMs;
      onMove?.(payload);
    },
    complete(payload: CompletePayload, atMs: number) {
      nowMs = atMs;
      onComplete?.(payload);
    },
    reset(payload: ResetPayload, atMs: number) {
      nowMs = atMs;
      onReset?.(payload);
    },
    frame(atMs: number) {
      nowMs = atMs;
      const callback = frames.shift();
      assert.ok(callback, `a frame is scheduled at ${atMs}ms`);
      callback(atMs);
    },
  };
}

async function settleInitialHotspot() {
  const harness = await makeOverlayHarness();
  harness.move({ actionId: 'initial', x: 20, y: 20, instant: true }, 0);
  harness.frame(0);
  harness.complete({ actionId: 'initial', x: 20, y: 20 }, 0);
  harness.frame(0);
  harness.reports.length = 0;
  harness.translations.length = 0;
  return harness;
}

test('one-fps overlay frames count from motion submission and open within the deadline', async () => {
  const harness = await settleInitialHotspot();
  const submittedAtMs = 10_000;
  harness.move({ actionId: 'long-move', x: 3800, y: 1500 }, submittedAtMs);

  harness.frame(submittedAtMs + 1000);
  const firstFramePosition = harness.translations.at(-1);
  assert.ok(firstFramePosition, 'the first one-fps frame paints the cursor');
  assert.ok(
    Math.hypot(firstFramePosition[0] - 20, firstFramePosition[1] - 20) > 1,
    'the first one-fps frame advances the submitted motion',
  );
  assert.equal(
    harness.reports.some((report) => report.actionId === 'long-move'),
    false,
    'the progress gate remains closed after one second',
  );

  harness.frame(submittedAtMs + 2000);
  assert.ok(
    harness.reports.some((report) => (
      report.actionId === 'long-move' && report.phase === 'readyForInteraction'
    )),
    'the one-fps observable frame opens before the 2100ms fence',
  );
  assert.equal(cursorPresentationReadyDeadlineMs(), 2100);
});

test('reset invalidates an old action before its queued frame executes', async () => {
  const harness = await settleInitialHotspot();
  harness.reset({ sessionId: 'old-session', generation: 1 }, 100);
  harness.frame(100);
  harness.reports.length = 0;

  harness.move({ actionId: 'old-action', x: 500, y: 300, instant: true }, 200);
  harness.reset({ sessionId: 'new-session', generation: 2 }, 201);
  harness.frame(201);

  assert.deepEqual(harness.reports, []);
});

test('interrupting a move aligns the old motion without replaying time into the replacement', async () => {
  const harness = await settleInitialHotspot();
  const model = new CursorEngine();
  model.setViewport(3840, 1600);
  model.completeAt(20, 20);

  harness.move({ actionId: 'old-move', x: 2000, y: 800 }, 1000);
  model.moveTo(2000, 800);
  model.tickTo(1000);
  harness.frame(1000);
  harness.frame(1500);
  model.tickTo(1500);

  harness.move({ actionId: 'replacement', x: 3800, y: 1500 }, 1800);
  model.tickTo(1800);
  const replacementStart: readonly [number, number] = [model.pos[0], model.pos[1]];
  model.moveTo(3800, 1500);
  model.tickTo(1800);
  harness.frame(1800);

  const painted = harness.translations.at(-1);
  assert.ok(painted, 'the replacement frame paints the cursor');
  assert.ok(
    Math.hypot(painted[0] - replacementStart[0], painted[1] - replacementStart[1]) < 1e-6,
    'elapsed time before replacement is applied only to the interrupted motion',
  );
  assert.ok(model.motionProgress() < CURSOR_CLOSE_ENOUGH.progress);
});
