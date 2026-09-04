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

const copy = getProviderSettingsCopy('zh').detail;
const MODEL_ID = 'custom-reasoner';

test('one save persists a context window that is still focused', async ({
  requestHeaderRowWindow: page,
}) => {
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.getByRole('button', { name: copy.addModel }).click();
  await page.getByRole('textbox', { name: copy.addModelIdField }).fill(MODEL_ID);
  await page.getByRole('spinbutton', { name: copy.addModelContextWindow }).fill('128000');
  await page.getByRole('button', { name: copy.addModelConfirm, exact: true }).click();
  await expect(
    page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }),
  ).toBeVisible();
  await page.getByRole('button', { name: copy.declareCapabilitiesAria(MODEL_ID) }).click();

  const contextWindow = page.getByRole('spinbutton', {
    name: `${copy.contextWindow} — ${MODEL_ID}`,
  });
  await contextWindow.fill('258000');
  const save = page.getByRole('button', { name: copy.save, exact: true });
  await expect(save).toBeDisabled();
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
});
