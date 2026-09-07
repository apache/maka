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

const GAP = '.maka-transcript-gap-row';
const TURN = '.maka-transcript-turn';

test('bounded transcript ranges expose only their truthful boundary gaps', async ({
  partialHistoryWindow: page,
}) => {
  await page.setViewportSize({ width: 1_400, height: 800 });

  const olderGap = page.locator('[data-transcript-gap="older"]');
  const newerGap = page.locator('[data-transcript-gap="newer"]');
  await expect(olderGap).toBeVisible();
  await expect(olderGap.getByRole('button', {
    name: /^(?:加载较早消息|Load earlier messages)$/,
  })).toBeVisible();
  await expect(newerGap).toHaveCount(0);
  await expect(page.locator('.maka-transcript-history-controls')).toHaveCount(0);

  const oldestPrompt = page.locator(
    '.maka-prompt-rail-tick[data-prompt-turn-id="turn-partial-history-1"]',
  );
  await expect(oldestPrompt).toBeVisible();
  await oldestPrompt.click();

  const firstTurn = page.locator('[data-turn-id="turn-partial-history-1"]');
  await expect(firstTurn).toBeVisible();
  await expect(firstTurn).toHaveAttribute('data-search-highlight', 'true');
  await expect(olderGap).toHaveCount(0);
  await expect(newerGap).toBeVisible();
  await expect(newerGap.getByRole('button', {
    name: /^(?:加载较新消息|Load newer messages)$/,
  })).toBeVisible();
  await expect(page.locator(GAP)).toHaveCount(1);
  expect(await page.locator(TURN).count()).toBeLessThanOrEqual(10);

  const loadNewer = newerGap.getByRole('button', {
    name: /^(?:加载较新消息|Load newer messages)$/,
  });
  await loadNewer.click();
  await expect(page.locator('[data-turn-id="turn-partial-history-2"]')).toBeVisible();
  await expect(olderGap).toHaveCount(0);
  await expect(newerGap).toBeVisible();
  await expect(loadNewer).toBeEnabled();

  await loadNewer.click();
  await expect(page.locator('[data-turn-id="turn-partial-history-3"]')).toBeVisible();
  await expect(olderGap).toBeVisible();
  await expect(newerGap).toBeVisible();
  await expect(loadNewer).toBeEnabled();
  await expect(oldestPrompt).toBeVisible();
  await expect(page.locator(GAP)).toHaveCount(2);
  expect(await page.locator(TURN).count()).toBeLessThanOrEqual(10);

  const returnToLatest = page.getByRole('button', {
    name: /^(?:滚动主对话到底部|Scroll main conversation to bottom)$/,
  });
  await expect(returnToLatest).toBeVisible();
  await returnToLatest.click();

  await expect(page.locator('[data-turn-id="turn-partial-history-18"]')).toBeVisible();
  await expect(newerGap).toHaveCount(0);
  await expect(oldestPrompt).toBeVisible();
  expect(await page.locator(TURN).count()).toBeLessThanOrEqual(10);
});
