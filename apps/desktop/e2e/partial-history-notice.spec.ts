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

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const SCROLLER = '[data-chat-scroll-container="true"]';
const TICK = '.maka-prompt-rail-tick';
/** Turns the partial-history fixture seeds. */
const PARTIAL_HISTORY_TURN_COUNT = 18;

async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate((remaining) => new Promise<void>((resolve) => {
    const step = (left: number): void => {
      if (left === 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(remaining);
  }), count);
}

/** The first Turn still on screen and its viewport top. */
async function readingAnchor(page: Page): Promise<{ turnId: string; top: number }> {
  return page.locator(SCROLLER).evaluate((scroller) => {
    const rootTop = scroller.getBoundingClientRect().top;
    const turn = [...scroller.querySelectorAll<HTMLElement>('[data-turn-id]')]
      .find((candidate) => candidate.getBoundingClientRect().bottom > rootTop);
    if (!turn?.dataset.turnId) throw new Error('no Turn is on screen');
    return { turnId: turn.dataset.turnId, top: turn.getBoundingClientRect().top };
  });
}

/** Wheel to the top as a reader would; a programmatic scroll does not release the tail pin. */
async function wheelToTop(page: Page): Promise<void> {
  const scroller = page.locator(SCROLLER);
  await expect(async () => {
    // Re-read each attempt: the window may still be resizing.
    const box = await scroller.boundingBox();
    if (!box) throw new Error('the chat scroll container has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
    await page.mouse.wheel(0, -4_000);
    await frames(page, 4);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  }).toPass({ timeout: 30_000 });
  await frames(page, 4);
}

async function turnTop(page: Page, turnId: string): Promise<number> {
  return page.locator(`[data-turn-id="${turnId}"]`).evaluate((turn) => turn.getBoundingClientRect().top);
}

test('a transcript over the history budget loads earlier Turns only on request, holding the reader', async ({
  partialHistoryWindow: page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1_400, height: 800 });
  const loadEarlier = page.getByRole('button', { name: '载入更早的记录' });
  const ticks = page.locator(TICK);

  await expect(page.locator(`[data-turn-id="turn-partial-history-${PARTIAL_HISTORY_TURN_COUNT}"]`)).toBeVisible();
  const opened = await ticks.count();
  expect(opened).toBeGreaterThan(0);
  expect(opened).toBeLessThan(PARTIAL_HISTORY_TURN_COUNT);

  // Reaching the top by scrolling loads nothing on its own.
  await wheelToTop(page);
  await page.waitForTimeout(500);
  expect(await ticks.count()).toBe(opened);
  await expect(loadEarlier).toHaveCount(1);

  let loads = 0;
  while ((await loadEarlier.count()) > 0) {
    await wheelToTop(page);
    const before = await ticks.count();
    const anchor = await readingAnchor(page);
    await loadEarlier.click();
    await expect.poll(() => ticks.count(), { timeout: 30_000 }).toBeGreaterThan(before);
    await frames(page, 4);
    const moved = Math.abs((await turnTop(page, anchor.turnId)) - anchor.top);
    expect(moved, `load-earlier moved ${anchor.turnId} by ${moved}px`).toBeLessThanOrEqual(1);
    loads += 1;
    expect(loads).toBeLessThan(PARTIAL_HISTORY_TURN_COUNT);
  }

  expect(loads).toBeGreaterThan(0);
  await expect(ticks).toHaveCount(PARTIAL_HISTORY_TURN_COUNT);
  await wheelToTop(page);
  await expect(page.locator('[data-turn-id="turn-partial-history-1"]')).toBeVisible();

  const returnToLatest = page.getByRole('button', {
    name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
  });
  await expect(returnToLatest).toBeVisible();
  await returnToLatest.click();
  await expect(page.locator(`[data-turn-id="turn-partial-history-${PARTIAL_HISTORY_TURN_COUNT}"]`)).toBeVisible();
  await expect(ticks).toHaveCount(PARTIAL_HISTORY_TURN_COUNT);
});
