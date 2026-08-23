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
import { getProviderSettingsCopy } from '../src/renderer/locales/settings-provider-copy';

/**
 * The custom request header row's remove button centres on the FIELD, not on
 * whatever box its own cell happens to declare.
 *
 * `.requestHeaderRow` is `align-items: start` on purpose: the value input can
 * grow an inline error underneath itself and the trash icon must not ride down
 * with it. That makes `.requestHeaderRemove` responsible for stating the height
 * it centres its button inside, and a wrong height there is invisible in a
 * diff — the rule looks deliberate either way. It regressed exactly once, as a
 * bare `min-height: 2.5rem` against 32px inputs, which parked the icon 4px low.
 *
 * `scripts/audit-alignment.mjs` cannot cover this. It clusters controls by
 * `parentElement`, and this row wraps every cell in its own div, so the inputs
 * and the button are never in the same cluster to compare. It also only sees
 * surfaces as they first render, and this editor is three clicks deep.
 */

const copy = getProviderSettingsCopy('zh').detail;

test('the request header remove button centres on its field', async ({
  requestHeaderRowWindow: page,
}) => {
  // `no-models` is the seeded openai-compatible relay — the custom relay whose
  // detail page carries the advanced request editor.
  await page.locator('[data-connection-slug="no-models"] button').first().click();
  await page.locator(`button[aria-label="${copy.edit}: ${copy.requestHeaders}"]`).click();
  await page.getByRole('button', { name: copy.addHeader }).click();
  await expect(page.locator('.requestHeaderRow')).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('.requestHeaderRow')!;
    // Select the actual field wrapper directly so this contract test measures
    // the visual field box, not a DOM relationship that may change.
    const field = row.querySelector<HTMLElement>('.requestHeaderName')!;
    const cell = row.querySelector<HTMLElement>('.requestHeaderRemove')!;
    const button = cell.querySelector<HTMLButtonElement>('button')!;
    const centre = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    return {
      drift: centre(button) - centre(field),
      fieldHeight: field.getBoundingClientRect().height,
      cellHeight: cell.getBoundingClientRect().height,
    };
  });

  // Allow a small amount of cross-platform/sub-pixel variance here: a
  // fractional device pixel ratio can shift centres slightly, but the 4px
  // regression this pins is still far outside this tolerance.
  expect(Math.abs(geometry.drift)).toBeLessThanOrEqual(1);
  // The mechanism, named separately so a failure says which half broke: the
  // cell must not declare a meaningfully taller box than the field it centres
  // against. Allow a small epsilon for DOMRect/font-rendering variance.
  expect(geometry.cellHeight).toBeLessThanOrEqual(geometry.fieldHeight + 1);
});
