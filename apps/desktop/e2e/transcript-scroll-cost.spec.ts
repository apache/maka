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
 * What one scroll through the transcript costs, asserted as per-frame geometry
 * rather than timings. Gestures are real wheel input through CDP.
 */

import type { CDPSession, Page } from '@playwright/test';
import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import { expect, test } from './fixtures';

const SCROLLER = '[data-chat-scroll-container="true"]';
const WHEEL_TICKS = 300;

/** Generous: a list that mounted everything it loaded would mount all 120 Turns. */
const MOUNTED_TURNS_MAX = 40;

/**
 * Per-frame backward motion of the thumb ratio allowed while the reader moves
 * one way. Row measurement corrects virtua's size estimates by a few pixels; a
 * range change swings the ratio by tenths.
 */
const THUMB_RATIO_TOLERANCE = 0.02;

/** Per-frame scrollHeight change allowed with no load-earlier and no streaming. */
const SCROLL_HEIGHT_DRIFT_MAX = 0.05;

interface Frame {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly mounted: number;
}

declare global {
  interface Window {
    __makaScrollFrames?: { frames: Frame[]; stop(): void };
  }
}

async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate((remaining) => new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left === 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(remaining);
  }), count);
}

async function wheel(page: Page, cdp: CDPSession, ticks: number, deltaY: number): Promise<void> {
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error('the chat scroll container has no box');
  for (let tick = 0; tick < ticks; tick += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      deltaX: 0,
      deltaY,
    });
    await frames(page, 1);
  }
  await frames(page, 4);
}

async function recordFrames(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const scroller = document.querySelector(selector);
    if (!scroller) throw new Error('the chat scroll container is missing');
    const state = { frames: [] as Frame[], stop: () => { running = false; } };
    let running = true;
    const tick = (): void => {
      if (!running) return;
      state.frames.push({
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        mounted: scroller.querySelectorAll('[data-turn-id]').length,
      });
      requestAnimationFrame(tick);
    };
    window.__makaScrollFrames = state;
    requestAnimationFrame(tick);
  }, SCROLLER);
}

async function stopFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const state = window.__makaScrollFrames;
    if (!state) throw new Error('the frame probe is missing');
    state.stop();
    return state.frames;
  });
}

function assertOneWay(recorded: readonly Frame[], direction: -1 | 1, label: string): void {
  expect(recorded.length, label).toBeGreaterThan(WHEEL_TICKS);
  const first = recorded[0];
  const last = recorded[recorded.length - 1];
  expect((last.scrollTop - first.scrollTop) * direction, `${label}: the reader has to travel`)
    .toBeGreaterThan(first.clientHeight * 10);
  const moving = recorded.filter((frame) => frame.scrollHeight > frame.clientHeight);
  for (let index = 1; index < moving.length; index += 1) {
    const before = moving[index - 1];
    const after = moving[index];
    const drift = Math.abs(after.scrollHeight - before.scrollHeight) / before.scrollHeight;
    expect(drift, `${label}: scrollHeight ${before.scrollHeight} -> ${after.scrollHeight} at frame ${index}`)
      .toBeLessThanOrEqual(SCROLL_HEIGHT_DRIFT_MAX);
    const ratio = (frame: Frame): number => frame.scrollTop / (frame.scrollHeight - frame.clientHeight);
    const backward = (ratio(before) - ratio(after)) * direction;
    expect(backward, `${label}: thumb ${ratio(before)} -> ${ratio(after)} at frame ${index}`)
      .toBeLessThanOrEqual(THUMB_RATIO_TOLERANCE);
    expect(after.mounted, `${label}: mounted Turns at frame ${index}`).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);
  }
}

test('a fully loaded transcript scrolls both ways with a stable document and bounded rows', async ({
  promptRailWindow: page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  const tail = page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`);
  await expect(tail).toHaveCount(1);
  await expect(page.locator('.maka-prompt-rail-tick')).toHaveCount(Math.min(PROMPT_RAIL_PROMPT_COUNT, 64));
  await expect(page.getByRole('button', { name: '载入更早的记录' })).toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);

  await page.locator(SCROLLER).evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
  await frames(page, 6);

  await recordFrames(page);
  await wheel(page, cdp, WHEEL_TICKS, -120);
  assertOneWay(await stopFrames(page), -1, 'scrolling up');

  await recordFrames(page);
  await wheel(page, cdp, WHEEL_TICKS, 120);
  assertOneWay(await stopFrames(page), 1, 'scrolling down');

  await wheel(page, cdp, 40, -120);
  const returnLatest = page.getByRole('button', {
    name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
  });
  await expect(returnLatest).toBeVisible();
  await returnLatest.click();
  await expect(tail).toBeVisible();
  await expect.poll(() => page.locator(SCROLLER).evaluate((scroller) =>
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)).toBeLessThanOrEqual(4);
  expect(await page.locator('[data-turn-id]').count()).toBeLessThanOrEqual(MOUNTED_TURNS_MAX);
});
