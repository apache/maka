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
import { getProviderSettingsCopy } from '../src/renderer/features/connection-settings';

const copy = getProviderSettingsCopy('zh-CN').detail;
const MODEL_ID = 'custom-reasoner';

test('one save persists integer and abbreviated context windows while focused', async ({
  requestHeaderRowWindow: page,
}, testInfo) => {
  const tokenField = (label: string) => page.getByLabel(label).and(page.locator('input'));
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.getByRole('button', { name: copy.addModel }).click();
  await page.getByRole('textbox', { name: copy.addModelIdField }).fill(MODEL_ID);
  await tokenField(copy.addModelContextWindow).fill('128000');
  await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();
  await expect(
    page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }),
  ).toBeVisible();
  await page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }).click();

  const contextWindow = tokenField(`${copy.contextWindow} — ${MODEL_ID}`);
  await contextWindow.fill('258000');
  const save = page.getByRole('button', { name: copy.save, exact: true });
  // Keep the field focused and exercise the physical gesture: Save is below
  // the scroll viewport, so scroll it into view without letting Playwright's
  // locator click wait for the blur-driven enabled state.
  await save.scrollIntoViewIfNeeded();
  const saveBox = await save.boundingBox();
  expect(saveBox).not.toBeNull();
  await page.mouse.click(saveBox!.x + saveBox!.width / 2, saveBox!.y + saveBox!.height / 2);

  await expect
    .poll(async () =>
      page.evaluate(async (modelId) => {
        const snapshot = await window.maka.connections.getSnapshot();
        return snapshot.connections
          .find((connection) => connection.slug === 'no-models')
          ?.relayModelProfiles?.[modelId]?.contextWindow;
      }, MODEL_ID),
    )
    .toBe(258_000);

  const suffixModel = 'custom-context-units';
  await page.getByRole('button', { name: copy.addModel }).click();
  await page.getByRole('textbox', { name: copy.addModelIdField }).fill(suffixModel);
  for (const [input, message] of [
    ['1MB', copy.contextWindowInputInvalid], ['', copy.addModelContextWindowRequired],
  ] as const) {
    await tokenField(copy.addModelContextWindow).fill(input);
    await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();
    await expect(page.getByRole('dialog').getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: copy.addModelIdField })).toHaveValue(suffixModel);
  }
  await tokenField(copy.addModelContextWindow).fill('1M');
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('context-window-units-add.png') });
  await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();
  await expect(page.getByRole('button', { name: copy.declareCapabilitiesAria(suffixModel) })).toBeVisible();
  const readWindow = () => page.evaluate(async (modelId) => {
    const snapshot = await window.maka.connections.getSnapshot();
    return snapshot.connections.find((connection) => connection.slug === 'no-models')
      ?.relayModelProfiles?.[modelId]?.contextWindow;
  }, suffixModel);
  await expect.poll(readWindow).toBe(1_000_000);

  const edit = page.getByRole('button', { name: copy.declareCapabilitiesAria(suffixModel) });
  await edit.click();
  const suffixWindow = tokenField(`${copy.contextWindow} — ${suffixModel}`);
  await suffixWindow.fill(' 1.5m ');
  await expect(suffixWindow).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('context-window-units-edit.png') });
  await save.click();
  await expect.poll(readWindow).toBe(1_500_000);

  await edit.click();
  await expect(suffixWindow).toHaveValue('1500000');
  await suffixWindow.fill('256K');
  await suffixWindow.fill('1MB');
  await suffixWindow.press('Tab');
  await expect(suffixWindow).toHaveValue('1MB');
  await expect(save).toBeDisabled();
  await expect(suffixWindow).toHaveAttribute('aria-invalid', 'true');
  await expect.poll(readWindow).toBe(1_500_000);
  await page.getByRole('button', { name: copy.cancel, exact: true }).click();
  await edit.click();
  await expect(suffixWindow).toHaveValue('1500000');
  await suffixWindow.fill('');
  await save.click();
  await expect.poll(readWindow).toBeUndefined();
  await expect.poll(async () => page.evaluate(async (modelId) => {
    const snapshot = await window.maka.connections.getSnapshot();
    return snapshot.connections.find((connection) => connection.slug === 'no-models')
      ?.relayModelProfiles?.[modelId]?.contextWindow;
  }, MODEL_ID)).toBe(258_000);
});
