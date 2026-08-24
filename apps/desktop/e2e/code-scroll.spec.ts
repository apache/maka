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
  window: page,
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
  const codeBox = await code.boundingBox();
  if (!codeBox) throw new Error('code line has no visible bounds');
  const textY = codeBox.y + Math.min(codeBox.height / 2, 18);
  await page.mouse.move(codeBox.x + 24, textY);
  await page.mouse.down();
  await page.mouse.move(metrics.rect.x + metrics.rect.width + 50, textY, { steps: 20 });
  await expect.poll(
    () => viewport.evaluate((element) => (element as HTMLElement).scrollLeft),
  ).toBeGreaterThan(0);
  await expect.poll(
    () => viewport.evaluate(() => window.getSelection()?.toString().length ?? 0),
  ).toBeGreaterThan(10);
  const afterSelectionDrag = await viewport.evaluate((element) => ({
    scrollLeft: (element as HTMLElement).scrollLeft,
    selection: window.getSelection()?.toString() ?? '',
  }));
  await page.mouse.up();
  expect(afterWheelScroll).toBeGreaterThan(0);
  expect(afterKeyboardScroll).toBeGreaterThan(0);
  expect(afterSelectionDrag.scrollLeft).toBeGreaterThan(0);
  expect(afterSelectionDrag.selection.length).toBeGreaterThan(10);
});
