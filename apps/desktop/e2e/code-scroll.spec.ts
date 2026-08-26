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

import { expect, test, COMPOSER_INPUT } from './fixtures';

test('a one-line Markdown code block exposes native and selection horizontal scrolling', async ({
  codeScrollWindow: { page, activate },
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const longLine = Array.from(
    { length: 80 },
    (_, index) => `word-${String(index).padStart(3, '0')}`,
  ).join(' ');
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill([
    'show these keys',
    '',
    '```',
    'short-key',
    '```',
    '',
    '```',
    longLine,
    '```',
  ].join('\n'));
  await composer.press('Enter');

  const codeBlocks = page.locator('.maka-markdown-code[data-maka-code-layout="single-line"]');
  const viewport = codeBlocks.last().locator('[role="group"]');
  await expect(viewport).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });

  const metrics = await viewport.evaluate((element) => {
    const node = element as HTMLElement;
    const rect = node.getBoundingClientRect();
    const code = node.querySelector('code');
    const line = code?.querySelector(':scope > [data-line]');
    if (!code || !line) throw new Error('code viewport has no line content');
    const codeRect = code.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      lineTopInset: lineRect.top - codeRect.top,
      lineBottomInset: codeRect.bottom - lineRect.bottom,
    };
  });
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(Math.abs(metrics.lineTopInset - metrics.lineBottomInset)).toBeLessThanOrEqual(1);

  const overflowX = await viewport.evaluate((element) => getComputedStyle(element).overflowX);
  expect(overflowX).toBe('auto');

  const viewportBox = await viewport.boundingBox();
  if (!viewportBox) throw new Error('native scroll viewport has no visible bounds');
  await page.mouse.move(
    viewportBox.x + viewportBox.width / 2,
    viewportBox.y + viewportBox.height / 2,
  );
  await page.mouse.wheel(240, 0);
  await expect.poll(
    () => viewport.evaluate((element) => (element as HTMLElement).scrollLeft),
  ).toBeGreaterThan(0);
  const afterWheelScroll = await viewport.evaluate(
    (element) => (element as HTMLElement).scrollLeft,
  );

  await viewport.evaluate((element) => {
    (element as HTMLElement).scrollLeft = 0;
  });
  await viewport.focus();
  await viewport.press('ArrowRight');
  await expect.poll(
    () => viewport.evaluate((element) => (element as HTMLElement).scrollLeft),
  ).toBeGreaterThan(0);
  const afterKeyboardScroll = await viewport.evaluate(
    (element) => (element as HTMLElement).scrollLeft,
  );

  await viewport.evaluate((element) => {
    (element as HTMLElement).scrollLeft = 0;
    window.getSelection()?.removeAllRanges();
  });
  const code = viewport.locator('code');
  const selectionGesture = await code.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    while (textNode && !(textNode.textContent ?? '').trim()) {
      textNode = walker.nextNode();
    }
    if (!textNode?.textContent) throw new Error('code line has no selectable text');
    const startRange = document.createRange();
    startRange.setStart(textNode, 0);
    startRange.setEnd(textNode, 1);
    const anchorRange = document.createRange();
    anchorRange.setStart(textNode, 0);
    anchorRange.setEnd(textNode, Math.min(12, textNode.textContent.length));
    const startRect = startRange.getBoundingClientRect();
    const anchorRect = anchorRange.getBoundingClientRect();
    if (
      startRect.width <= 0 || startRect.height <= 0 ||
      anchorRect.width <= 0 || anchorRect.height <= 0
    ) {
      throw new Error('code line text has no visible range');
    }
    return {
      startX: startRect.left + startRect.width / 2,
      anchorX: anchorRect.right - startRect.width / 2,
      y: startRect.top + startRect.height / 2,
    };
  });
  const moveAcrossPaintedFrames = async (fromX: number, toX: number, steps: number) => {
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      await page.mouse.move(fromX + (toX - fromX) * progress, selectionGesture.y);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
  };
  await page.bringToFront();
  const nativeFocus = await activate();
  expect(nativeFocus.appActive).toBe(true);
  expect(nativeFocus.windowFocused).toBe(true);
  await page.mouse.click(metrics.rect.x + metrics.rect.width / 2, selectionGesture.y);
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await viewport.evaluate(() => window.getSelection()?.removeAllRanges());

  let afterSelectionDrag: { scrollLeft: number; selection: string } | undefined;
  await page.mouse.move(selectionGesture.startX, selectionGesture.y);
  await page.mouse.down();
  try {
    await moveAcrossPaintedFrames(selectionGesture.startX, selectionGesture.anchorX, 8);
    await expect.poll(
      () => viewport.evaluate(() => window.getSelection()?.toString().length ?? 0),
    ).toBeGreaterThan(3);
    await moveAcrossPaintedFrames(
      selectionGesture.anchorX,
      metrics.rect.x + metrics.rect.width + 50,
      20,
    );
    await expect.poll(
      () => viewport.evaluate((element) => (element as HTMLElement).scrollLeft),
    ).toBeGreaterThan(0);
    await expect.poll(
      () => viewport.evaluate(() => window.getSelection()?.toString().length ?? 0),
    ).toBeGreaterThan(10);
    afterSelectionDrag = await viewport.evaluate((element) => ({
      scrollLeft: (element as HTMLElement).scrollLeft,
      selection: window.getSelection()?.toString() ?? '',
    }));
  } finally {
    await page.mouse.up();
  }
  if (!afterSelectionDrag) throw new Error('selection drag did not settle');
  expect(afterWheelScroll).toBeGreaterThan(0);
  expect(afterKeyboardScroll).toBeGreaterThan(0);
  expect(afterSelectionDrag.scrollLeft).toBeGreaterThan(0);
  expect(afterSelectionDrag.selection.length).toBeGreaterThan(10);
});
