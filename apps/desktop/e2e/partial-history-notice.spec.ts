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

const TURN = '.maka-transcript-turn';
/** Turns the partial-history fixture seeds. */
const PARTIAL_HISTORY_TURN_COUNT = 18;

test('a bounded transcript range reaches its whole history without a control to ask', async ({
  partialHistoryWindow: page,
}) => {
  await page.setViewportSize({ width: 1_400, height: 800 });

  await expect(page.locator(TURN).first()).toBeVisible();
  expect(await page.locator(TURN).count()).toBeLessThan(PARTIAL_HISTORY_TURN_COUNT);

  const oldestPrompt = page.locator(
    '.maka-prompt-rail-tick[data-prompt-turn-id="turn-partial-history-1"]',
  );
  await expect(oldestPrompt).toBeVisible();
  await oldestPrompt.click();

  await expect(page.locator('[data-turn-id="turn-partial-history-1"]')).toBeVisible();
  // Where the jump landed, read from the reading position rather than from
  // `data-search-highlight`: that highlight clears itself 2.2s after the
  // command lands, so waiting for the Turn to mount and then asserting it
  // fails whenever loading the page around it takes longer than the flash —
  // measured here as a 3s pass turning into an 18s timeout under load.
  await expect(oldestPrompt).toHaveAttribute('data-active', 'true');
  // A jump lands on its own page, not on the whole history.
  expect(await page.locator(TURN).count()).toBeLessThan(PARTIAL_HISTORY_TURN_COUNT);

  // The newer side of the jump fills on its own as the reader moves into it.
  await page.mouse.move(700, 400);
  await expect(async () => {
    await page.mouse.wheel(0, 400);
    await expect(page.locator('[data-turn-id="turn-partial-history-3"]')).toBeVisible();
  }).toPass({ timeout: 30_000 });

  const returnToLatest = page.getByRole('button', {
    name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
  });
  await expect(returnToLatest).toBeVisible();
  await returnToLatest.click();

  // Reading the tail page and rebuilding the window around it is slower than
  // the paging above, and measured past the suite's 10s expect timeout here.
  await expect(page.locator(`[data-turn-id="turn-partial-history-${PARTIAL_HISTORY_TURN_COUNT}"]`))
    .toBeVisible({ timeout: 30_000 });
  await expect(oldestPrompt).toBeVisible();
  expect(await page.locator(TURN).count()).toBeLessThan(PARTIAL_HISTORY_TURN_COUNT);
});
