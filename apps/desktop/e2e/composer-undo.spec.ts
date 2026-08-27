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

import type { Locator } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';

const TYPED = 'x';
const PASTED = '中文 <tag>& "quoted"\r\nhttps://example.test/path?x=1&y=2\n第二行 <>&';
const PASTED_AS_PLAIN_TEXT = PASTED.replace(/\r\n/g, '\n');
const UNDO_SHORTCUT = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

async function expectComposerText(
  composer: Locator,
  expected: string,
): Promise<void> {
  await expect
    .poll(() => composer.evaluate((element) => element.innerText.replace(/\r\n/g, '\n')))
    .toBe(expected);
}

async function pastePlainText(composer: Locator, pasted: string): Promise<void> {
  await composer.evaluate((element, text) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, pasted);
}

test('plain-text paste is undone separately from prior typing', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);

  await composer.click();
  await page.keyboard.type(TYPED);
  await expectComposerText(composer, TYPED);

  await pastePlainText(composer, PASTED);
  await expectComposerText(composer, `${TYPED}${PASTED_AS_PLAIN_TEXT}`);

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, TYPED);

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, '');

  await page.keyboard.press(UNDO_SHORTCUT);
  await expectComposerText(composer, '');
});

test('pasted absolute path sends on the first Enter without opening the slash menu', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const pasted = '/Users/me/notes.txt';

  await expect(page.locator('button.maka-workspace-picker')).toBeEnabled();
  await composer.click();
  await pastePlainText(composer, pasted);

  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${pasted}`)).toBeVisible();
});

test('pasted mention-looking text does not open the file menu', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);

  await expect(page.locator('button.maka-workspace-picker')).toBeEnabled();
  await composer.click();
  await pastePlainText(composer, 'review @name');

  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('plain-text paste closes an existing trigger menu before the first Enter', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const pasted = 'Users/me/notes.txt';

  await expect(page.locator('button.maka-workspace-picker')).toBeEnabled();
  await composer.click();
  await composer.pressSequentially('/');
  await expect(composer).toHaveAttribute('aria-expanded', 'true');

  await pastePlainText(composer, pasted);

  await expect(composer).toHaveAttribute('aria-expanded', 'false');
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: /${pasted}`)).toBeVisible();
});

test('plain-text paste synchronizes the controlled draft once', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);

  await expect(page.locator('button.maka-workspace-picker')).toBeEnabled();
  await page.evaluate(() => {
    const storageKey = 'maka-new-task-reload-intent-v1';
    sessionStorage.setItem(storageKey, JSON.stringify({ draft: '' }));
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (key === storageKey) writes += 1;
      originalSetItem.call(this, key, value);
    };
    Object.defineProperty(globalThis, '__makaComposerDraftWrites', {
      configurable: true,
      get: () => writes,
    });
  });

  await composer.click();
  await pastePlainText(composer, 'one controlled change');

  const writes = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { __makaComposerDraftWrites?: number })
        .__makaComposerDraftWrites ?? 0,
  );
  expect(writes).toBe(1);
});
