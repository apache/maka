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

test('assistant prose reaches the transcript column edge on a wide window', async ({
  window: page,
}) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('measure');
  await composer.press('Enter');

  const answer = page.getByRole('article', { name: 'Maka 的回答' }).last();
  const paragraph = answer.locator('[role="paragraph"]').first();
  await expect(paragraph).toBeVisible();

  const edges = await paragraph.evaluate((element) => {
    const turn = element.closest('.maka-turn');
    if (!turn) throw new Error('assistant paragraph is not inside a turn');
    const turnRect = turn.getBoundingClientRect();
    return {
      turnWidth: turnRect.width,
      rightGap: turnRect.right - element.getBoundingClientRect().right,
    };
  });

  // Guard against a false pass when both boxes are viewport-constrained:
  // a turn wider than Astryx's own 680px cap is the case that regressed.
  expect(edges.turnWidth).toBeGreaterThan(680);
  expect(edges.rightGap).toBeLessThanOrEqual(1);
});
