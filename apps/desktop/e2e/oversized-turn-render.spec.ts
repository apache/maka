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

import { COMPOSER_INPUT, expect, test } from './fixtures';

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

test('keyboard focus into a skipped card releases the live tail', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  const boundary = await root.evaluate((element, segmentSelector) => {
    // Use the actual sequential focus order inside the transcript. The
    // containment boundary is the tool-card row around Astryx's native button,
    // so visibility must be asked of that row rather than its focused child.
    const headers = [...element.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]')]
      .map((header) => ({ header, row: header.closest<HTMLElement>(segmentSelector) }))
      .filter((entry): entry is { header: HTMLElement; row: HTMLElement } =>
        entry.row != null,
      );
    for (let index = 1; index < headers.length; index += 1) {
      const previous = headers[index - 1]!;
      const anchor = headers[index]!;
      if (
        !previous.row.checkVisibility({ contentVisibilityAuto: true })
        && anchor.row.checkVisibility({ contentVisibilityAuto: true })
      ) {
        previous.header.dataset.focusBoundaryTarget = 'true';
        anchor.header.dataset.focusBoundaryAnchor = 'true';
        anchor.header.focus({ preventScroll: true });
        return { found: true, headerCount: headers.length };
      }
    }
    return { found: false, headerCount: headers.length };
  }, SEGMENT);
  expect(boundary.headerCount).toBeGreaterThan(5);
  expect(boundary.found).toBe(true);

  // This is the normal sequential-navigation path, not a synthetic focus
  // event. Shift+Tab enters the immediately preceding skipped activity card.
  await page.keyboard.press('Shift+Tab');
  await waitForPaintedFrames(page, 6);

  const focused = await root.evaluate((element) => {
    const active = document.activeElement as HTMLElement | null;
    const rootRect = element.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      target: active?.dataset.focusBoundaryTarget === 'true',
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      top: element.scrollTop,
      activeTop: activeRect?.top ?? Number.NaN,
      withinViewport: activeRect != null
        && activeRect.bottom > rootRect.top
        && activeRect.top < rootRect.bottom,
    };
  });
  expect(focused.target).toBe(true);
  expect(focused.distance).toBeGreaterThan(100);
  expect(focused.withinViewport).toBe(true);

  // A later content delivery resizes the observed transcript box. It must not
  // re-pin and move the focused card out from under keyboard/AT navigation.
  await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const growth = document.createElement('div');
    growth.style.height = '600px';
    list.append(growth);
  });
  await waitForPaintedFrames(page);

  const afterGrowth = await root.evaluate((element) => {
    const active = document.activeElement as HTMLElement | null;
    return {
      target: active?.dataset.focusBoundaryTarget === 'true',
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      top: element.scrollTop,
      activeTop: active?.getBoundingClientRect().top ?? Number.NaN,
    };
  });
  expect(afterGrowth.target).toBe(true);
  expect(afterGrowth.distance).toBeGreaterThan(focused.distance);
  expect(Math.abs(afterGrowth.top - focused.top)).toBeLessThanOrEqual(4);
  expect(Math.abs(afterGrowth.activeTop - focused.activeTop)).toBeLessThanOrEqual(4);
});

test('visible composer focus during pending growth keeps the live tail', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  const pending = await root.evaluate((element, composerSelector) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const composer = element.querySelector<HTMLElement>(composerSelector);
    if (!composer) throw new Error('the visible composer is missing');
    const rootRect = element.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();

    // Keep the first mutation and focus in one task. ResizeObserver is therefore
    // still pending when the visible control receives focus, which is the race
    // where root distance must not be mistaken for reader movement.
    const firstGrowth = document.createElement('div');
    firstGrowth.dataset.pendingFocusGrowth = 'true';
    firstGrowth.style.height = '600px';
    list.append(firstGrowth);
    composer.focus();
    return {
      focused: document.activeElement === composer,
      visible:
        composerRect.bottom > rootRect.top && composerRect.top < rootRect.bottom,
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  }, COMPOSER_INPUT);
  expect(pending.focused).toBe(true);
  expect(pending.visible).toBe(true);
  expect(pending.distance).toBeGreaterThan(100);
  await waitForPaintedFrames(page, 6);

  const afterPendingGrowth = await root.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  expect(afterPendingGrowth).toBeLessThanOrEqual(4);

  await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const secondGrowth = document.createElement('div');
    secondGrowth.dataset.followUpFocusGrowth = 'true';
    secondGrowth.style.height = '300px';
    list.append(secondGrowth);
  });
  await waitForPaintedFrames(page, 6);

  const result = await root.evaluate((element, composerSelector) => ({
    distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    composerFocused: document.activeElement === element.querySelector(composerSelector),
  }), COMPOSER_INPUT);
  expect(result.composerFocused).toBe(true);
  expect(result.distance).toBeLessThanOrEqual(4);
});
