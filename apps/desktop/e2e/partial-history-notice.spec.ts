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

const NOTICE = '.maka-transcript-history-controls';

async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function noticePresentation(page: Page) {
  return page.locator(NOTICE).evaluate((notice) => {
    const style = getComputedStyle(notice);
    const box = notice.getBoundingClientRect();
    const composer = document.querySelector('.maka-composer-astryx');
    if (!composer) throw new Error('the composer is missing');
    const composerBox = composer.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ],
      display: style.display,
      flexWrap: style.flexWrap,
      justifyContent: style.justifyContent,
      widthDelta: Math.abs(box.width - composerBox.width),
      centerDelta: Math.abs(
        (box.left + box.right) / 2 - (composerBox.left + composerBox.right) / 2,
      ),
      fitsViewport: box.left >= 0 && box.right <= document.documentElement.clientWidth,
      hasHorizontalOverflow: notice.scrollWidth > notice.clientWidth,
    };
  });
}

test('partial history is a quiet reading-column control with neutral rail ticks', async ({
  partialHistoryWindow: page,
}) => {
  await page.setViewportSize({ width: 1_400, height: 800 });
  await expect(page.locator(NOTICE)).toHaveCount(0);

  const firstPrompt = page.locator(
    '.maka-prompt-rail-tick[data-prompt-turn-id="turn-partial-history-1"]',
  );
  await expect(firstPrompt).toBeVisible();
  await firstPrompt.click();

  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('正在查看较早的消息');
  await expect(notice.getByRole('button', { name: '返回最新消息' })).toBeVisible();
  await expect(notice).not.toContainText(/保存|加载/);

  const regular = await noticePresentation(page);
  expect(regular).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    borderWidths: ['0px', '0px', '0px', '0px'],
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    widthDelta: expect.any(Number),
    centerDelta: expect.any(Number),
    fitsViewport: true,
    hasHorizontalOverflow: false,
  });
  expect(regular.widthDelta).toBeLessThanOrEqual(1);
  expect(regular.centerDelta).toBeLessThanOrEqual(1);

  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const railPresentation = await page.evaluate(() => {
    const ticks = [...document.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick')];
    const presentation = (tick: HTMLElement) => {
      const bar = tick.querySelector<HTMLElement>('.maka-prompt-rail-tick-bar');
      if (!bar) throw new Error('a prompt rail tick is missing its bar');
      const style = getComputedStyle(bar);
      return {
        backgroundColor: style.backgroundColor,
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        boxShadow: style.boxShadow,
      };
    };
    const neutralPaint = ticks
      .filter((tick) => tick.dataset.active !== 'true' && !tick.matches(':hover'))
      .map(presentation);
    const residentStyleRules = [...document.styleSheets].flatMap((sheet) =>
      [...sheet.cssRules].filter((rule) => rule.cssText.includes('data-resident'))
    );
    return {
      residentAttributeCount: document.querySelectorAll('[data-resident]').length,
      residentStyleRuleCount: residentStyleRules.length,
      neutralTickCount: neutralPaint.length,
      neutralPaintCount: new Set(neutralPaint.map((paint) => JSON.stringify(paint))).size,
    };
  });
  expect(railPresentation.residentAttributeCount).toBe(0);
  expect(railPresentation.residentStyleRuleCount).toBe(0);
  expect(railPresentation.neutralTickCount).toBeGreaterThan(1);
  expect(railPresentation.neutralPaintCount).toBe(1);

  await page.setViewportSize({ width: 520, height: 720 });
  await waitForPaint(page);
  const narrow = await noticePresentation(page);
  expect(narrow.centerDelta).toBeLessThanOrEqual(1);
  expect(narrow.fitsViewport).toBe(true);
  expect(narrow.hasHorizontalOverflow).toBe(false);

  await notice.getByRole('button', { name: '返回最新消息' }).click();
  await expect(notice).toHaveCount(0);
  await expect(
    page.locator('[data-turn-id="turn-partial-history-8"]'),
  ).toBeVisible();
});
