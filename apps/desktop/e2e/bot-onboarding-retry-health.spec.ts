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
import { getBotSettingsCopy } from '../src/renderer/locales/settings-bot-copy';

test('bot onboarding shows bounded retry health while preserving the QR', async ({
  linkColorWindow: page,
}, testInfo) => {
  const status = page.locator('.settingsBotOnboardingStatus');
  const expectedStatuses = (['zh', 'en'] as const).map((locale) =>
    getBotSettingsCopy(locale).onboarding.retrying('server', 1, 3),
  );
  await expect(status).toHaveAttribute('data-state', 'waiting');
  await expect.poll(async () => expectedStatuses.includes(await status.innerText())).toBe(true);
  await expect(status).not.toContainText('HTTP 503');
  await expect(status).not.toContainText('provider detail');
  await expect(page.locator('.settingsBotOnboardingQrFrame img')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('bot-onboarding-retry-health.png') });
});
