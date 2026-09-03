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
    const headers = [...element.querySelectorAll<HTMLElement>(
      '.maka-tool-activity-card [role="button"][tabindex="0"]',
    )]
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
    const rootRect = element.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    return {
      target: active?.dataset.focusBoundaryTarget === 'true',
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      withinViewport: activeRect != null
        && activeRect.bottom > rootRect.top
        && activeRect.top < rootRect.bottom,
    };
  });
  expect(afterGrowth.target).toBe(true);
  expect(afterGrowth.distance).toBeGreaterThan(focused.distance);
  // Intrinsic-size correction may move the row by one placeholder while native
  // anchoring settles. The accessibility contract is that focus remains on the
  // same card and later growth cannot push it out of the viewport.
  expect(afterGrowth.withinViewport).toBe(true);
});

test('visible transcript focus during pending growth keeps the live tail', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  const pending = await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
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

    // Keep the first mutation and focus in one task. ResizeObserver is therefore
    // still pending when the visible control receives focus, which is the race
    // where root distance must not be mistaken for reader movement.
    header.focus({ preventScroll: true });
    header.blur();
    const firstGrowth = document.createElement('div');
    firstGrowth.dataset.pendingFocusGrowth = 'true';
    firstGrowth.style.height = '600px';
    list.append(firstGrowth);
    header.focus();
    const headerRect = header.getBoundingClientRect();
    return {
      focused: document.activeElement === header,
      visible:
        headerRect.bottom > rootRect.top && headerRect.top < rootRect.bottom,
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    };
  });
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

  const result = await root.evaluate((element) => ({
    distance: element.scrollHeight - element.scrollTop - element.clientHeight,
    transcriptControlFocused:
      document.activeElement?.matches('[data-maka-transcript-boundary] [role="button"]') ?? false,
  }));
  expect(result.transcriptControlFocused).toBe(true);
  expect(result.distance).toBeLessThanOrEqual(4);
});

test('Focus between two visible transcript controls under pending growth keeps the live tail', async ({
  oversizedTurnWindow: page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const root = page.locator(SCROLLER);
  await root.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await waitForPaintedFrames(page);

  const groupHeader = root.locator('.maka-tool-activity-card [role="button"]').first();
  await expect(groupHeader).toBeVisible();
  await groupHeader.click();
  await waitForPaintedFrames(page);
  await waitForStableScrollGeometry(page);

  const pending = await root.evaluate((element) => {
    const list = element.querySelector('.maka-chat-message-list');
    if (!list) throw new Error('the transcript content box is missing');
    const rootRect = element.getBoundingClientRect();
    const visibleHeaders = [...element.querySelectorAll<HTMLElement>(
      '.maka-tool-activity-card [role="button"]',
    )].filter((candidate) => {
      const boundary = candidate.closest<HTMLElement>('[data-maka-transcript-boundary]');
      const rect = candidate.getBoundingClientRect();
      return Boolean(boundary?.checkVisibility({ contentVisibilityAuto: true }))
        && rect.top >= rootRect.top
        && rect.bottom <= rootRect.bottom;
    });
    if (visibleHeaders.length < 2) {
      throw new Error('need two visible tool-card controls for the focus regression');
    }
    const from = visibleHeaders[0]!;
    const to = visibleHeaders[1]!;
    to.dataset.tabTarget = 'true';

    // One task: focus the first visible control, append growth, then move focus
    // to the second visible control so `focusout` carries a real in-transcript
    // `relatedTarget` while the ResizeObserver is still pending. A reader
    // stepping between two controls they can both see has not left the tail, so
    // the pin must survive — this is the release path the blur-to-body fixtures
    // could not reach.
    from.focus({ preventScroll: true });
    const growth = document.createElement('div');
    growth.dataset.tabPendingGrowth = 'true';
    growth.style.height = '600px';
    list.append(growth);
    to.focus();

    const toRect = to.getBoundingClientRect();
    return {
      focusedTarget: document.activeElement === to,
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      toVisible: toRect.bottom > rootRect.top && toRect.top < rootRect.bottom,
    };
  });
  expect(pending.focusedTarget).toBe(true);
  expect(pending.toVisible).toBe(true);
  expect(pending.distance).toBeGreaterThan(100);
  await waitForPaintedFrames(page, 6);
  await waitForStableScrollGeometry(page);

  const settled = await root.evaluate((element) => {
    const active = document.activeElement as HTMLElement | null;
    return {
      distance: element.scrollHeight - element.scrollTop - element.clientHeight,
      transcriptControlFocused:
        active?.matches('[data-maka-transcript-boundary] [role="button"]') ?? false,
      stillOnTarget: active?.dataset.tabTarget === 'true',
    };
  });
  expect(settled.transcriptControlFocused).toBe(true);
  expect(settled.stillOnTarget).toBe(true);
  expect(settled.distance).toBeLessThanOrEqual(4);
});
