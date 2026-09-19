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

// Verifies the installed Pricing contextBridge, IPC handlers and selected-Host
// adapter together. A missing handler, wrong Host scope or lost mutation/result
// serialization is invisible to injected Storybook services and handler fakes.
// The saved override must be readable through a new preload after renderer reload.
// Picker, tab scope and focus contracts live in the existing Pricing stories.
test('pricing writes cross preload and main and remain readable after renderer reload', async ({
  window: page,
}) => {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '使用统计', exact: true }).click();
  await page
    .getByRole('navigation', { name: '使用统计视图' })
    .getByRole('button', { name: '定价配置', exact: true })
    .click();

  const modelKey = `e2e:pricing-ipc-${Date.now()}`;
  const pricing = { modelKey, inputUsdPer1M: 1, outputUsdPer1M: 2 };
  const host = await page.evaluate(() => window.maka.runtimeHostProfiles.getDefaultHost());
  await page.getByRole('button', { name: '添加定价' }).click();
  const editor = page.getByRole('dialog', { name: '添加定价' });
  await editor.getByRole('button', { name: '模型不在列表中？手动输入' }).click();
  await editor.getByRole('textbox', { name: /模型键/ }).fill(modelKey);
  await editor.getByRole('textbox', { name: /输入价格/ }).fill('1');
  await editor.getByRole('textbox', { name: /输出价格/ }).fill('2');
  await editor.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => page.evaluate(async ({ host, modelKey }) => {
    const snapshot = await window.maka.settings.pricing.load(host);
    return snapshot.entries.find((row) => row.pricing.modelKey === modelKey)?.pricing;
  }, { host, modelKey })).toEqual(pricing);

  await page.reload();
  await expect.poll(() => page.evaluate(async ({ host, modelKey }) => {
    const snapshot = await window.maka.settings.pricing.load(host);
    return snapshot.entries.find((row) => row.pricing.modelKey === modelKey)?.pricing;
  }, { host, modelKey })).toEqual(pricing);

  const removed = await page.evaluate(async ({ host, modelKey }) => {
    const base = await window.maka.settings.pricing.load(host);
    return window.maka.settings.pricing.mutate(base, { kind: 'delete', modelKey }, host);
  }, { host, modelKey });
  expect(removed.kind).toBe('saved');
  await expect.poll(() => page.evaluate(async ({ host, modelKey }) => {
    const snapshot = await window.maka.settings.pricing.load(host);
    return snapshot.entries.some((row) => row.pricing.modelKey === modelKey);
  }, { host, modelKey })).toBe(false);
});
