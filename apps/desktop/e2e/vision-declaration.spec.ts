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

test('the vision field states its verdict until a declaration replaces it', async ({
  requestHeaderRowWindow: page,
}) => {
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.getByRole('button', { name: copy.addModel }).click();
  await page.getByRole('textbox', { name: copy.addModelIdField }).fill(MODEL_ID);
  await page.getByRole('spinbutton', { name: copy.addModelContextWindow }).fill('128000');
  await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();
  await page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }).click();

  // This provider reports nothing about the id and no metadata describes it, so
  // 默认 resolves to "no". The field says so rather than leaving the user to
  // read an absent capability as a decision Maka reached.
  const vision = page.getByRole('combobox', { name: `${copy.visionInput} — ${MODEL_ID}` });
  await expect(vision).toHaveText(copy.visionAuto);
  await expect(page.getByText(copy.visionResolvedHint(false))).toBeVisible();

  // Declaring one replaces the verdict: the control now carries the answer, and
  // the field stops speaking for Maka.
  await vision.click();
  await page
    .getByRole('listbox')
    .getByRole('option', { name: copy.visionEnabledOption })
    .click();
  await expect(page.getByText(copy.visionResolvedHint(false))).toBeHidden();
  await page.getByRole('button', { name: copy.save, exact: true }).click();

  await expect
    .poll(async () =>
      page.evaluate(async (modelId) => {
        const snapshot = await window.maka.connections.getSnapshot();
        return snapshot.connections
          .find((connection) => connection.slug === 'no-models')
          ?.relayModelProfiles?.[modelId]?.vision;
      }, MODEL_ID),
    )
    .toBe(true);
  // Read back from the Host, so what the row reports is the Host's resolution of
  // the saved table rather than a renderer-side guess.
  await expect(page.getByText(copy.visionResolvedHint(false))).toBeHidden();
});
