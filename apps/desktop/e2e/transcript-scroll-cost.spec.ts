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
 * What the Session the Host delivered costs to read: the whole transcript
 * arrives in one read across preload/IPC, and the reader can walk it with real
 * wheel input and come back without the window mounting it all.
 *
 * Per-frame geometry — reader displacement, the thumb, the document's extent —
 * is renderer-owned and belongs to the browser stories over real layout
 * (`UpwardTraversalHoldsTurnGeometry`, `PrependedHistoryKeepsMeasuredHeights`).
 */

import type { CDPSession, Page } from '@playwright/test';
import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import { expect, test } from './fixtures';

const SCROLLER = '[data-chat-scroll-container="true"]';
const WHEEL_TICKS = 300;

/** Generous: a list that mounted everything it loaded would mount all 120 Turns. */
const MOUNTED_TURNS_MAX = 40;

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

async function offset(page: Page): Promise<number> {
  return page.locator(SCROLLER).evaluate((scroller) => scroller.scrollTop);
}

test('a fully loaded transcript scrolls both ways with bounded rows', async ({
  promptRailWindow: page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_000, height: 700 });
  const tail = page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`);
  await expect(tail).toHaveCount(1);
  await expect(page.locator('.maka-prompt-rail-tick')).toHaveCount(Math.min(PROMPT_RAIL_PROMPT_COUNT, 64));
  // One read brought the Session over: there is nothing left to ask for.
  await expect(page.getByRole('button', { name: '载入更早的记录' })).toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);

  await page.locator(SCROLLER).evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
  await frames(page, 6);
  const bottom = await offset(page);

  await wheel(page, cdp, WHEEL_TICKS, -120);
  const top = await offset(page);
  expect(bottom - top, 'the reader has to travel').toBeGreaterThan(700 * 10);
  expect(await page.locator('[data-turn-id]').count(), 'mounted Turns at the top')
    .toBeLessThanOrEqual(MOUNTED_TURNS_MAX);

  await wheel(page, cdp, WHEEL_TICKS, 120);
  expect(await offset(page), 'and back down').toBeGreaterThan(top + 700 * 10);

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
