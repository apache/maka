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

import { ensureSidebarExpanded, expect, test } from './fixtures';

test('persists Korean locale preference through reload', async ({ window: page }) => {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Settings content' })).toBeVisible();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  // The Settings → General row labels itself `interfaceLanguage`
  // (`Interface language` in en) — main-process confirmation copy uses
  // `UI language`, which is not on this surface.
  await expect(page.getByText('Interface language', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.evaluate(async () => {
    await window.maka.settings.update({ personalization: { uiLocale: 'ko' } });
  });
  await page.reload();
  await page.waitForSelector('.maka-composer-editor');
  await ensureSidebarExpanded(page);

  const locale = await page.evaluate(async () => {
    const settings = await window.maka.settings.read();
    return settings.personalization.uiLocale;
  });
  expect(locale).toBe('ko');

  // The preference must not only persist — it has to be applied. Core locale
  // resolution surfaces the resolved locale on the document root, so assert it
  // actually took effect instead of just being stored.
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.locator('html')).toHaveAttribute('data-maka-locale', 'ko');

  // Renderer chrome labels are English stubs by design in this PR (the real
  // renderer catalogs land with the renderer slices #3977–#3979). Keep a smoke
  // check that Settings → General still renders after the switch so a future
  // real Korean translation flips this assertion instead of silently passing.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Settings content' })).toBeVisible();
});
