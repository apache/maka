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
 * Locks the two invariants of the Astryx sidenav column that live only in
 * hand-tuned CSS and were, before this file, verified by nothing (#3834):
 *
 *   1. Geometry — `.maka-sidenav-motion { height: 100% }` (shell-layout.css).
 *      Without a definite height the wrapper grows to its unclipped content and
 *      the footer leaves the window. `sidenav footer stays inside the window`
 *      is the lock shell-layout.css's comment already names by this path.
 *
 *   2. The resize handle — the two workaround rules that keep it grabbable:
 *      `top: var(--h-titlebar)` (shell-layout.css) and `transform: none
 *      !important` (sidebar.css, the Astryx hitAreaOffsetX fix). A regression
 *      in either leaves a column that looks right and simply cannot be dragged.
 *      `resize handle drag ...` grabs the handle at its vertical centre — the
 *      exact point the bug left ungrabbable — and asserts the width changes.
 *
 * Both run on `projectSidebarWindow`: the only fixture that boots the shell
 * expanded (so the handle is mounted) with a populated, overflowing list (60
 * sessions, so the footer has content to be pushed past). It opens with the
 * search modal over an inert shell, so dismiss it first — the same first step
 * sidebar-project-row.spec.ts takes.
 */

import { expect, test } from './fixtures';
import {
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
} from '../src/renderer/features/session-navigation/testing';
import type { Locator, Page } from '@playwright/test';

async function revealPopulatedSidebar(page: Page): Promise<Locator> {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-maka-contract="search-modal"]')).not.toBeVisible();
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function wrapperWidth(wrapper: Locator): Promise<number> {
  const box = await wrapper.boundingBox();
  if (!box) throw new Error('sidenav wrapper (.maka-sidenav-motion) has no visible bounds');
  return box.width;
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

test('resize handle drag from its vertical centre changes the column width', async ({
  projectSidebarWindow: page,
}) => {
  await revealPopulatedSidebar(page);

  const handle = page.getByTestId('astryx-sidenav-resize-handle');
  await expect(handle).toBeVisible();
  const wrapper = page.locator('.maka-sidenav-motion');

  const initialWidth = await wrapperWidth(wrapper);
  expect(initialWidth).toBeGreaterThanOrEqual(SESSION_LIST_EXPANDED_MIN_WIDTH);
  expect(initialWidth).toBeLessThanOrEqual(SESSION_LIST_EXPANDED_MAX_WIDTH);

  // Grab the vertical centre. The Astryx hitAreaOffsetX bug leaves only the top
  // half grabbable, so the centre no-ops unless sidebar.css's `transform: none
  // !important` is applied — this point is the regression probe for that rule.
  // Let locator actionability resolve the handle's live centre before reading
  // its endpoint; replaying a box captured before that wait can miss a moving
  // 16px handle under load.
  await handle.hover();
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error('resize handle has no visible bounds');
  const grabX = handleBox.x + handleBox.width / 2;
  const grabY = handleBox.y + handleBox.height / 2;

  await page.mouse.down();

  // Astryx flags the separator while a drag is in flight; shell-layout.css keys
  // its transition-suppression (`:has([data-resizing])`) on it, so the width
  // tracks the pointer live rather than easing behind it. Check the second the
  // pointer goes down, so a missed grab fails directly instead of timing out on
  // an unrelated width assertion.
  await expect(handle).toHaveAttribute('data-resizing', /.*/);
  await page.mouse.move(grabX + 80, grabY, { steps: 20 });
  await expect.poll(() => wrapperWidth(wrapper)).toBeGreaterThan(initialWidth + 40);
  await page.mouse.up();
  await expect(handle).not.toHaveAttribute('data-resizing', /.*/);

  const widenedWidth = await wrapperWidth(wrapper);
  expect(widenedWidth).toBeGreaterThan(initialWidth + 40);
  expect(widenedWidth).toBeLessThanOrEqual(SESSION_LIST_EXPANDED_MAX_WIDTH + 1);

  // Drag the other way to prove the handle also narrows the column, grabbing
  // the centre again at the handle's new right-edge position.
  await handle.hover();
  const widenedHandleBox = await handle.boundingBox();
  if (!widenedHandleBox) throw new Error('resize handle lost its bounds after widening');
  const shrinkX = widenedHandleBox.x + widenedHandleBox.width / 2;
  const shrinkY = widenedHandleBox.y + widenedHandleBox.height / 2;

  await page.mouse.down();
  await expect(handle).toHaveAttribute('data-resizing', /.*/);
  // Undo the 80px widening. Keeping the reverse drag symmetric means every
  // width accepted by the precondition stays above the collapsible region.
  await page.mouse.move(shrinkX - 80, shrinkY, { steps: 20 });
  await expect.poll(() => wrapperWidth(wrapper)).toBeLessThan(widenedWidth - 40);
  await page.mouse.up();
  await expect(handle).not.toHaveAttribute('data-resizing', /.*/);

  const narrowedWidth = await wrapperWidth(wrapper);
  expect(narrowedWidth).toBeLessThan(widenedWidth - 40);
  expect(narrowedWidth).toBeGreaterThanOrEqual(SESSION_LIST_EXPANDED_MIN_WIDTH);
});
