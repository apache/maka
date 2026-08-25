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
import { expect, test, COMPOSER_INPUT } from './fixtures';

async function establishSourceAndTarget(
  page: Page,
  targetName: string,
): Promise<string> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('建立发送方任务');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: 建立发送方任务')).toBeVisible();
  return page.evaluate(async (name) => {
    const source = (await window.maka.sessions.list())[0];
    if (!source) throw new Error('source Session was not created');
    const target = await window.maka.sessions.create({
      name,
      cwd: source.cwd,
      projectId: source.projectId,
    });
    return target.id;
  }, targetName);
}

async function selectMailboxTarget(
  page: Page,
  query: string,
  targetName: string,
): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('/send');
  await composer.press('Enter');
  const search = page.getByPlaceholder('搜索任务名称…');
  await expect(search).toBeVisible();
  await search.fill(query);
  const target = page.getByRole('option', { name: new RegExp(targetName) });
  await expect(target).toBeVisible();
  await target.click();
}

test('selects a searchable /send target and settles delivery into the transcript', async ({
  window: page,
}, testInfo) => {
  const composer = page.locator(COMPOSER_INPUT);
  await establishSourceAndTarget(page, '支付回调恢复检查');
  await selectMailboxTarget(page, '恢复检查', '支付回调恢复检查');

  await expect(page.getByText('发送给“支付回调恢复检查”')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('session-mailbox-before-send.png') });
  await composer.fill('请检查回执恢复链路');
  await composer.press('Enter');

  const card = page.locator('.maka-session-mailbox-bubble', {
    hasText: '请检查回执恢复链路',
  });
  await expect(card).toContainText('支付回调恢复检查');
  await expect(card).toContainText(/已送达|已排队/);
  await expect(page.getByText('发送给“支付回调恢复检查”')).toHaveCount(0);
  const dismissToast = page.getByRole('button', { name: '关闭通知' });
  if (await dismissToast.isVisible()) await dismissToast.click();
  await page.screenshot({ path: testInfo.outputPath('session-mailbox-card.png') });
});

test('cancels a selected /send target without consuming the next message', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await establishSourceAndTarget(page, '可以取消的任务');
  await selectMailboxTarget(page, '可以取消', '可以取消的任务');

  const notice = page.locator('[data-send-target-notice="true"]');
  await expect(notice).toContainText('发送给“可以取消的任务”');
  await notice.getByRole('button', { name: '取消' }).click();
  await expect(notice).toHaveCount(0);

  await composer.fill('取消后仍是普通消息');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: 取消后仍是普通消息')).toBeVisible();
  await expect(page.locator('.maka-session-mailbox-bubble')).toHaveCount(0);
});

test('keeps failed /send delivery actionable after the target becomes unavailable', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const targetId = await establishSourceAndTarget(page, '即将归档的任务');
  await selectMailboxTarget(page, '即将归档', '即将归档的任务');
  await page.evaluate((sessionId) => window.maka.sessions.archive(sessionId), targetId);

  await composer.fill('这条发送应当失败');
  await composer.press('Enter');
  const notice = page.locator('[data-send-target-notice="true"]');
  await expect(notice).toHaveAttribute('data-delivery-status', 'failed');
  await expect(notice).toContainText('发送给“即将归档的任务”失败');
  await expect(composer).toHaveText('这条发送应当失败');
  await expect(page.locator('.maka-session-mailbox-bubble')).toHaveCount(0);
});
