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

import type { Page } from '@playwright/test';
import { COMPOSER_INPUT, NEW_TASK_PROJECT_NAME, expect, test } from './fixtures';

/**
 * #3408, in the real window: the new-task draft slot is keyed by (profile,
 * host, project), and the workspace picker that changes the project part sits
 * directly under the composer — so "type, then pick where it runs" re-keyed the
 * slot mid-typing and swapped the text out for the new target's empty one.
 *
 * `chat-composer-region-draft-handoff.test.ts` pins the handoff at the
 * component. This pins the wiring the user actually touches: that the picker is
 * what re-keys the composer, and that the draft survives it.
 */
const DRAFT = 'draft written before choosing a project';

/**
 * Read the composer only after the click's render has committed AND its passive
 * effects have flushed. The draft swap runs in an effect after the picker's own
 * re-render, so a read taken between the two sees the text still on screen and
 * passes against broken code — which is exactly what an earlier version of this
 * spec did. `newTaskTargetWindow` is shown for the same reason: a hidden
 * window's compositor is throttled to ~1fps, which stretched that gap from
 * 0.1ms to seconds and made every assertion here vacuous.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('the new-task draft follows the Project chosen under the composer', async ({
  newTaskTargetWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const picker = page.locator('button.maka-workspace-picker');

  // Wait for the seeded Project to be the resolved target before typing: until
  // the catalog settles the draft key is the unresolved one, whose handoff is a
  // different path and was never broken.
  await expect(picker).toHaveAttribute('aria-label', new RegExp(NEW_TASK_PROJECT_NAME));

  await composer.click();
  await page.keyboard.type(DRAFT);
  await expect(composer).toHaveText(DRAFT);

  await picker.click();
  await page.getByRole('menuitem', { name: '无项目', exact: true }).click();
  // The picker's label is the selected target, so this asserts the click moved
  // the selection. Without it the draft assertion below would still pass if the
  // menu item stopped selecting anything at all.
  await expect(picker).toHaveAttribute('aria-label', /无项目/);
  await settle(page);
  await expect(composer).toHaveText(DRAFT);

  await picker.click();
  await page.getByRole('menuitem', { name: NEW_TASK_PROJECT_NAME, exact: true }).click();
  await expect(picker).toHaveAttribute('aria-label', new RegExp(NEW_TASK_PROJECT_NAME));
  await settle(page);
  await expect(composer).toHaveText(DRAFT);
});

test('a staged attachment survives the Project chosen under the composer', async ({
  newTaskTargetWindow: page,
}) => {
  const picker = page.locator('button.maka-workspace-picker');
  const chip = page.locator('.maka-composer-attachment-token');
  await expect(picker).toHaveAttribute('aria-label', new RegExp(NEW_TASK_PROJECT_NAME));

  await page.locator('.maka-composer').first().evaluate((form) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['staged'], 'dropped-notes.txt', { type: 'text/plain' }));
    form.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(chip).toHaveCount(1);

  await picker.click();
  await page.getByRole('menuitem', { name: '无项目', exact: true }).click();
  await expect(picker).toHaveAttribute('aria-label', /无项目/);
  await settle(page);
  await expect(chip).toHaveCount(1);
});
