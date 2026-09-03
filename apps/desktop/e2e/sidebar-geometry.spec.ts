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

/*
 * Locks `.maka-sidenav-motion { height: 100% }` in shell-layout.css. Without a
 * definite height, the sidenav grows to its unclipped content and pushes the
 * footer below the window. `projectSidebarWindow` supplies the overflowing
 * session list needed to expose that regression.
 */

import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

async function revealPopulatedSidebar(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await expect(sidebar).toBeVisible();
}

test('sidenav footer stays inside the window under an overflowing list', async ({
  projectSidebarWindow: page,
}) => {
  await revealPopulatedSidebar(page);

  // Precondition: the list genuinely overflows its scrollport. Without this the
  // footer-in-window assertion below would pass even if `height: 100%` were
  // dropped, because short content never grows past the wrapper's parent.
  const listOverflows = await page.evaluate(() => {
    const nav = document.querySelector('nav.maka-session-panel');
    if (!nav) return false;
    return [nav, ...nav.querySelectorAll('*')].some(
      (element) =>
        element.scrollHeight - element.clientHeight > 4 &&
        getComputedStyle(element).overflowY !== 'visible',
    );
  });
  expect(listOverflows).toBe(true);

  const wrapper = page.locator('.maka-sidenav-motion');
  const footer = page.locator('.maka-session-panel-footer');
  await expect(footer).toBeVisible();

  const innerHeight = await page.evaluate(() => window.innerHeight);
  const [wrapperBox, footerBox] = await Promise.all([
    wrapper.boundingBox(),
    footer.boundingBox(),
  ]);
  expect(wrapperBox).not.toBeNull();
  expect(footerBox).not.toBeNull();

  // The definite height caps the wrapper at the window; the footer rides its
  // bottom edge. Drop `height: 100%` and the wrapper grows to ~60 rows tall,
  // taking the footer far below the fold — both bottoms then exceed innerHeight.
  expect(wrapperBox!.y + wrapperBox!.height).toBeLessThanOrEqual(innerHeight + 1);
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(innerHeight + 1);
});
