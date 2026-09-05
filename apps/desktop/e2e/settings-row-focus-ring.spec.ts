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
import type { Locator, Page } from '@playwright/test';

/**
 * A settings row rings its OWN tab stop and nothing else.
 *
 * Astryx's Item draws `outline: 2px solid accent` at `:has(:focus-visible)`
 * unconditionally. That is right only for a row whose click target is the
 * invisible `<button>` Item renders for `onClick`/`href`. Every other row holds
 * a control that rings itself, so the row outline was a second ring around the
 * whole label + description + control band.
 *
 * Opening the 默认模型 picker showed it at its worst: a Selector popup is a
 * native `popover`, so the top layer moves where the popup PAINTS but not where
 * it sits in the DOM. Focus lands on the popup's search input, `:has()` walks
 * up to the row, and the row drew a full-width ring while the trigger drew
 * none — reported as "点开下拉框时外面整行都会出现一个蓝色的框".
 *
 * `packages/ui/src/styles.css` narrows the ring to the row's own tab stop.
 * Three things have to hold together, and a fix that over-reaches passes the
 * first two while failing the third:
 *
 *   1. an open picker leaves its row unringed,
 *   2. keyboard focus on a row control rings the CONTROL and not the row,
 *   3. a clickable row still rings, because there the ring IS the indicator.
 *
 * Computed style rather than a screenshot: the ring is one declaration, and
 * reading it back needs no tolerance for anti-aliasing or theme drift.
 */

async function openSettingsPage(page: Page, section: string) {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

/** Tab until `target` owns focus, so the browser treats it as keyboard focus. */
async function tabTo(page: Page, target: Locator, limit = 40) {
  for (let index = 0; index < limit; index++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Tab order never reached the target control');
}

/** The row around whatever currently has focus, and whether it draws a ring. */
function focusedRowOutline() {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest('.astryx-item') as HTMLElement | null;
  if (!row) return null;
  const style = getComputedStyle(row);
  return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
}

/** The trigger's own focus affordance: Astryx fields state it in the border. */
const fieldChrome = (element: SVGElement | HTMLElement) => {
  const field = (element as HTMLElement).parentElement as HTMLElement;
  const style = getComputedStyle(field);
  return `${style.borderColor} | ${style.boxShadow}`;
};

test('an open picker does not ring the settings row that hosts it', async ({
  window: page,
}) => {
  await openSettingsPage(page, '通用');
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();
  await page.getByRole('button', { name: '默认模型' }).click();

  // Wait for the state under test to actually exist before reading it. Astryx
  // hands the popup's search input focus inside a requestAnimationFrame
  // (Selector.tsx `onOpen`), so a read that wins that race would find focus
  // still on the mouse-clicked trigger — which is not `:focus-visible`, so
  // NOTHING rings and the assertion below passes against the bug too. Waiting
  // on the condition rather than on a timeout is what keeps this test honest.
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return (
      document.querySelector('[popover]:popover-open') != null &&
      active instanceof HTMLElement &&
      active.closest('[popover]:popover-open') != null
    );
  });

  const state = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const row = active.closest('.astryx-item') as HTMLElement | null;
    return {
      // The mechanism, asserted so the ring check can never pass vacuously:
      // the focused popup input is still a DOM descendant of the row, because
      // the top layer moves where a popover PAINTS and not where it sits. If
      // that ever stops being true this test goes quiet instead of green.
      focusInsideRow: row != null,
      outlineStyle: row ? getComputedStyle(row).outlineStyle : null,
    };
  });

  expect(state.focusInsideRow).toBe(true);
  expect(state.outlineStyle).toBe('none');
});

test('keyboard focus rings the row control, never the row', async ({ window: page }) => {
  await openSettingsPage(page, '通用');
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();

  const trigger = page.getByRole('button', { name: '默认模型' });
  const resting = await trigger.evaluate(fieldChrome);

  await page.getByRole('textbox', { name: '助手语气偏好' }).focus();
  await tabTo(page, trigger);

  expect((await page.evaluate(focusedRowOutline))?.outlineStyle).toBe('none');
  // …and the control still says it has focus. Astryx's field convention is an
  // accent border, not an outline, which is why dropping the row's outline
  // costs no keyboard visibility. Polled because border-color transitions.
  await expect.poll(() => trigger.evaluate(fieldChrome)).not.toBe(resting);
});

test('a row whose own tab stop is the click target keeps its ring', async ({
  window: page,
}) => {
  await openSettingsPage(page, '远程接入');

  // A catalog row is a clickable Item, so Item renders an invisible <button>
  // as a direct child and the row outline is that button's only indicator.
  const row = page.locator('.settingsRemoteAccessCatalogRow').first();
  await expect(row).toBeVisible();
  const rowButton = row.locator(':scope > button').first();

  await page.getByRole('button', { name: '远程接入', exact: true }).focus();
  await tabTo(page, rowButton);

  expect(await page.evaluate(focusedRowOutline)).toEqual({
    outlineStyle: 'solid',
    outlineWidth: '2px',
  });
});

test('the row keeps its ring under forced colors, where the control loses its own', async ({
  window: page,
}) => {
  await openSettingsPage(page, '通用');
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();
  await page.emulateMedia({ forcedColors: 'active' });

  const trigger = page.getByRole('button', { name: '默认模型' });
  const resting = await trigger.evaluate(fieldChrome);

  await page.getByRole('textbox', { name: '助手语气偏好' }).focus();
  await tabTo(page, trigger);

  // Windows High Contrast drops box-shadow and repaints every border in one
  // system color, so the field's own affordance reads the same focused as
  // resting — measured here rather than assumed, because it is the entire
  // reason the row must keep its ring.
  expect(await trigger.evaluate(fieldChrome)).toBe(resting);
  expect((await page.evaluate(focusedRowOutline))?.outlineStyle).toBe('solid');
});
