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
