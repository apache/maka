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

test('an explicit new task survives a renderer reload without reopening history', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create history');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create history/)).toBeVisible();

  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await composer.fill('draft survives renderer replacement');

  await page.reload();

  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('draft survives renderer replacement');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
});
