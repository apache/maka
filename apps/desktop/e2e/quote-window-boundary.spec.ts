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

// This stays in Electron: the physical pointer leaves the renderer viewport,
// and Chromium pointer capture must route its release back to the owning Turn.
test('a transcript drag releases outside the window through its owning Turn', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('pointer capture source');
  await composer.press('Enter');

  // Select from a settled answer. Selecting from a streaming one is broken for
  // an unrelated reason — see the fixme below — and this test exists to pin the
  // pointer-capture contract, not Selection survival across a stream close.
  //
  // Settled is three things, each landing on its own schedule after the
  // footer: the lazy Markdown body has replaced its plain-text fallback (a
  // drag begun in the fallback selects nodes about to be discarded), the
  // stored turn has rendered (its timestamp row moves the answer down), and
  // the transcript has written itself back to the tail.
  const reply = page
    .locator('[data-maka-contract="markdown"]')
    .getByText(/Fake backend received: pointer capture source/);
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByRole('article', { name: '你发送的消息' }).locator('time')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('[data-chat-scroll-container="true"]')!;
        return root.scrollHeight - root.scrollTop - root.clientHeight;
      }),
    )
    .toBeLessThanOrEqual(4);
  const turn = reply.locator('xpath=ancestor::*[@data-turn-id][1]');
  const quoteLayer = page.locator('.maka-quote-actions');
  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    owner.addEventListener('gotpointercapture', (event) => {
      owner.dataset.e2eCapturedPointer = String((event as PointerEvent).pointerId);
    });
    owner.addEventListener('pointerup', () => {
      owner.dataset.e2eCapturedPointerUp = 'true';
    });
    document.addEventListener('selectionchange', () => {
      owner.dataset.e2eSelectionChanged = 'true';
    });
  });

  const bounds = await reply.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (bounds.width < 8 || bounds.height < 1) {
    throw new Error('quote selection source has no visible text bounds');
  }
  const y = bounds.y + bounds.height / 2;
  const startX = bounds.x + 2;
  const selectedX = bounds.x + bounds.width - 2;

  await turn.evaluate((element) => {
    const owner = element as HTMLElement;
    delete owner.dataset.e2eSelectionChanged;
  });

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(selectedX, y, { steps: 5 });
  await expect(turn).toHaveAttribute('data-e2e-captured-pointer', /\d+/);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed === false))
    .toBe(true);
  await expect(turn).toHaveAttribute('data-e2e-selection-changed', 'true');
  await page.mouse.move(1220, y, { steps: 5 });
  await page.mouse.up();

  await expect(turn).toHaveAttribute('data-e2e-captured-pointer-up', 'true');
  await expect(quoteLayer).toBeVisible();
});
