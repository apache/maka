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
const MODEL_ID = 'custom-vision';

test('adding and configuring a disabled model preserves its parameters and selection', async ({
  requestHeaderRowWindow: page,
}) => {
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.getByRole('button', { name: copy.addModel }).click();
  await page.getByRole('textbox', { name: copy.addModelIdField }).fill(MODEL_ID);
  await page.getByRole('textbox', { name: copy.contextWindow }).fill('128K');
  const vision = page.getByRole('combobox', { name: copy.visionInput });
  await vision.click();
  await page
    .getByRole('listbox')
    .getByRole('option', { name: copy.visionEnabledOption })
    .click();
  await page.getByRole('button', { name: copy.thinkingEffort }).click();
  await page.getByRole('menuitemcheckbox', { name: `${MODEL_ID} low` }).click();
  await page.getByRole('button', { name: copy.thinkingEffort }).press('Escape');
  await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();

  await expect
    .poll(async () =>
      page.evaluate(async (modelId) => {
        const snapshot = await window.maka.connections.getSnapshot();
        return snapshot.connections.find((connection) => connection.slug === 'no-models')
          ?.catalogEntries.find((entry) => entry.id === modelId)?.supportsVision;
      }, MODEL_ID),
    )
    .toBe(true);
  const enable = page.getByRole('switch', { name: copy.enableModelAria(MODEL_ID) });
  await enable.click();
  await expect(enable).not.toBeChecked();
  await page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }).click();
  await expect(vision).toHaveText(copy.visionEnabledOption);
  await vision.click();
  await page.getByRole('listbox').getByRole('option', { name: copy.visionDefaultOption(false) }).click();
  await expect(vision).toHaveText(copy.visionDefaultOption(false));
  await page.getByRole('button', { name: copy.save, exact: true }).click();
  await expect.poll(async () => page.evaluate(async (modelId) => {
    const snapshot = await window.maka.connections.getSnapshot();
    const connection = snapshot.connections.find((item) => item.slug === 'no-models');
    return {
      enabled: connection?.enabledModelIds.includes(modelId),
      declared: connection?.modelOverrides?.[modelId]?.vision ?? null,
      resolved: connection?.catalogEntries.find((entry) => entry.id === modelId)?.supportsVision,
      thinking: connection?.modelOverrides?.[modelId]?.thinkingLevels,
      contextWindow: connection?.modelOverrides?.[modelId]?.contextWindow,
    };
  }, MODEL_ID)).toEqual({ enabled: false, declared: null, resolved: false, thinking: ['low'], contextWindow: 128000 });
  await page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }).click();
  await expect(vision).toHaveText(copy.visionDefaultOption(false));
  await page.getByRole('button', { name: copy.cancel, exact: true }).click();
  await enable.click();
  await expect(enable).toBeChecked();
  await expect.poll(async () => page.evaluate(async (modelId) => {
    const snapshot = await window.maka.connections.getSnapshot();
    const connection = snapshot.connections.find((item) => item.slug === 'no-models');
    return { enabled: connection?.enabledModelIds.includes(modelId), profile: connection?.modelOverrides?.[modelId] };
  }, MODEL_ID)).toEqual({ enabled: true, profile: { thinkingLevels: ['low'], contextWindow: 128000 } });
});
