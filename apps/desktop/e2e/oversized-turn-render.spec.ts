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

const SEGMENT = '[data-maka-transcript-boundary]';
const SCROLLER = '[data-chat-scroll-container="true"]';

async function waitForPaintedFrames(page: import('@playwright/test').Page, frames = 4) {
  await page.evaluate(async (count) => {
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);
}

async function waitForStableScrollGeometry(page: import('@playwright/test').Page) {
  await page.evaluate(async (selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) throw new Error('the chat scroll container is missing');
    let previous = '';
    let stableFrames = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = [root.scrollTop, root.scrollHeight, root.clientHeight].join(':');
      if (current === previous) stableFrames += 1;
      else stableFrames = 0;
      if (stableFrames >= 4) return;
      previous = current;
    }
    throw new Error('transcript scroll geometry did not settle');
  }, SCROLLER);
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
  await waitForStableScrollGeometry(page);

  const released = await root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const center = (rootRect.top + rootRect.bottom) / 2;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-maka-transcript-boundary]')]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > rootRect.top && rect.top < rootRect.bottom;
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return Math.abs((leftRect.top + leftRect.bottom) / 2 - center)
          - Math.abs((rightRect.top + rightRect.bottom) / 2 - center);
      })[0];
    if (!anchor) throw new Error('the reader scroll has no visible reading anchor');
    anchor.dataset.readingAnchor = 'true';
    return {
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
  expect(released.distance).toBeGreaterThan(100);

  // A later delivery must preserve the released position too. Without the
  // release, the scroll authority writes the latest tail on this resize.
  await root.evaluate((element) => {
    const growth = element.querySelector<HTMLElement>('[data-oversized-turn-growth]');
    if (!growth) throw new Error('the synthetic growth box is missing');
    growth.style.height = '900px';
  });
  await waitForPaintedFrames(page);
  await waitForStableScrollGeometry(page);

  const afterGrowth = await root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const anchor = element.querySelector<HTMLElement>('[data-reading-anchor]');
    const anchorRect = anchor?.getBoundingClientRect();
    return {
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      anchorVisible: anchorRect != null
        && anchorRect.bottom > rootRect.top
        && anchorRect.top < rootRect.bottom,
    };
  });
  expect(afterGrowth.distance).toBeGreaterThan(released.distance);
  expect(afterGrowth.anchorVisible).toBe(true);
});

test('PageUp releases the live tail while skipped geometry materializes', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    // The production scroller carries no tabindex, so `event.target === root`
    // is unreachable there. A real PageUp is dispatched from a focused control
    // inside the list and reaches the handler through
    // `event.target.closest('.maka-chat-message-list')`. Focus a visible card
    // header to exercise that path instead of focusing the scroller itself.
    const rootRect = element.getBoundingClientRect();
    const header = [...element.querySelectorAll<HTMLElement>(
      '.maka-tool-activity-card [role="button"][tabindex="0"]',
    )].find((candidate) => {
      const boundary = candidate.closest<HTMLElement>('[data-maka-transcript-boundary]');
      const rect = candidate.getBoundingClientRect();
      return boundary?.checkVisibility({ contentVisibilityAuto: true })
        && rect.top >= rootRect.top
        && rect.bottom <= rootRect.bottom;
    });
    if (!header) throw new Error('the visible tool-card header is missing');
    header.focus({ preventScroll: true });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'PageUp') return;
      const growth = document.createElement('div');
      growth.dataset.keyboardGrowth = 'true';
      growth.style.height = '600px';
      list.append(growth);
    }, { capture: true, once: true });
  });

  await page.keyboard.press('PageUp');
  await waitForPaintedFrames(page, 6);
  await waitForStableScrollGeometry(page);
  const released = await root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const center = (rootRect.top + rootRect.bottom) / 2;
    const anchor = [...element.querySelectorAll<HTMLElement>('[data-maka-transcript-boundary]')]
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > rootRect.top && rect.top < rootRect.bottom;
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return Math.abs((leftRect.top + leftRect.bottom) / 2 - center)
          - Math.abs((rightRect.top + rightRect.bottom) / 2 - center);
      })[0];
    if (!anchor) throw new Error('the keyboard scroll has no visible reading anchor');
    anchor.dataset.readingAnchor = 'true';
    return {
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
  expect(released.distance).toBeGreaterThan(100);

  await root.evaluate((element) => {
    const growth = element.querySelector<HTMLElement>('[data-keyboard-growth]');
    if (!growth) throw new Error('the keyboard growth box is missing');
    growth.style.height = '900px';
  });
  await waitForPaintedFrames(page);
  await waitForStableScrollGeometry(page);
  const afterGrowth = await root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const anchor = element.querySelector<HTMLElement>('[data-reading-anchor]');
    const anchorRect = anchor?.getBoundingClientRect();
    return {
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      anchorVisible: anchorRect != null
        && anchorRect.bottom > rootRect.top
        && anchorRect.top < rootRect.bottom,
    };
  });
  expect(afterGrowth.distance).toBeGreaterThan(released.distance);
  expect(afterGrowth.anchorVisible).toBe(true);
});
