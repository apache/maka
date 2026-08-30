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

import { expect, test } from './fixtures';

const SEGMENT = [
  '.maka-assistant-answer-content > .maka-chat-message-bubble-assistant',
  '.maka-assistant-answer-content > .maka-processing-sequence',
  '.maka-processing-sequence > *',
].join(',');
const SCROLLER = '[data-chat-scroll-container="true"]';

async function waitForPaintedFrames(page: import('@playwright/test').Page, frames = 4) {
  await page.evaluate(async (count) => {
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);
}

test('an oversized single Turn skips offscreen timeline blocks', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const segments = page.locator(SEGMENT);
  await expect(segments).not.toHaveCount(0);
  expect(await segments.count()).toBeGreaterThan(80);

  const state = await segments.evaluateAll((elements) => {
    const rows = elements as HTMLElement[];
    return {
      automatic: rows.filter((element) =>
        getComputedStyle(element).contentVisibility === 'auto').length,
      skipped: rows.filter((element) =>
        !element.checkVisibility({ contentVisibilityAuto: true })).length,
    };
  });
  expect(state.automatic).toBe(await segments.count());
  expect(state.skipped).toBeGreaterThan(0);

  const first = segments.first();
  await first.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  expect(await first.evaluate((element) =>
    element.checkVisibility({ contentVisibilityAuto: true }),
  )).toBe(true);
});

test('upward scrolling releases the live tail while skipped geometry materializes', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  const atTail = await root.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  expect(atTail).toBeLessThanOrEqual(4);

  // Force the ordering from the field report: the wheel begins materializing
  // an intrinsic-size block before Chromium delivers the resulting scroll.
  // Appending below the reader is deterministic synthetic growth; approaching
  // the skipped timeline blocks above adds the real content-visibility change.
  await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    element.addEventListener('wheel', () => {
      const growth = document.createElement('div');
      growth.dataset.oversizedTurnGrowth = 'true';
      growth.style.height = '600px';
      list.append(growth);
    }, { capture: true, once: true });
  });

  await root.hover();
  await page.mouse.wheel(0, -500);
  await waitForPaintedFrames(page, 6);

  const released = await root.evaluate((element) => ({
    distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    top: element.scrollTop,
  }));
  expect(released.distance).toBeGreaterThan(100);

  // A later delivery must preserve the released position too. Without the
  // release, the scroll authority writes the latest tail on this resize.
  await root.evaluate((element) => {
    const growth = element.querySelector<HTMLElement>('[data-oversized-turn-growth]');
    if (!growth) throw new Error('the synthetic growth box is missing');
    growth.style.height = '900px';
  });
  await waitForPaintedFrames(page);

  const afterGrowth = await root.evaluate((element) => ({
    distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    top: element.scrollTop,
  }));
  expect(afterGrowth.distance).toBeGreaterThan(released.distance);
  expect(Math.abs(afterGrowth.top - released.top)).toBeLessThanOrEqual(4);
});
