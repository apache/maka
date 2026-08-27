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

import { COMPOSER_INPUT, ensureSidebarExpanded, expect, test } from './fixtures';

test('WorkHub rebuilds Session conversation after navigating away and back', async ({
  window: page,
}) => {
  const initialPrompt = '检查支付回调重复投递时的幂等性';
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(initialPrompt);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });

  const sessionName = await page.evaluate(async () =>
    (await window.maka.sessions.list())[0]?.name,
  );
  expect(sessionName).toBeTruthy();
  await page.evaluate(async () => {
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });
  await expect(page.getByRole('main', { name: 'WorkHub' })).toBeVisible();
  // The conversation is the Coordination Session transcript. An ordinary
  // Session is a routing target and a status row, never a turn in WorkHub.
  await expect(page.getByText('1 项工作', { exact: true })).toBeVisible();
  await expect(page.locator('.workhub-turn')).toHaveCount(0);
  await expect(page.locator('.workhub-empty h2')).toHaveText('从这里继续所有工作');

  const routedPrompt = '继续这个工作，补充重复投递测试点。';
  const workHubComposer = page.locator(
    '.workhub-surface .maka-composer-editor [contenteditable="true"]',
  );
  await workHubComposer.fill(routedPrompt);
  await workHubComposer.press('Enter');
  await expect(page.locator('.workhub-submitted').last()).toBeVisible();
  await page.locator('.workhub-turn', { hasText: routedPrompt })
    .locator('.workhub-submitted > button')
    .click();
  await expect(page.getByRole('main', { name: 'WorkHub' })).toBeHidden();

  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: 'WorkHub', exact: true }).click();
  await expect(page.getByRole('main', { name: 'WorkHub' })).toBeVisible();
  await expect(
    page.locator('.workhub-projected-turn .workhub-user-bubble > p', {
      hasText: routedPrompt,
    }),
  ).toBeVisible();
});

test('WorkHub defers destructive correction until linked delegation exists', async ({
  window: page,
}) => {
  const sourceSessionName = '检查支付回调重复投递时的幂等性';
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(sourceSessionName);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await page.evaluate(async (name) => {
    const sourceSession = (await window.maka.sessions.list())[0];
    if (!sourceSession) throw new Error('Source Session was not found');
    await window.maka.sessions.rename(sourceSession.id, name);
  }, sourceSessionName);
  await page.evaluate(async () => {
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });
  await expect(page.getByRole('main', { name: 'WorkHub' })).toBeVisible();
  await page.evaluate(async () => {
    await window.maka.sessions.create({ name: '登录稳定性' });
  });
  await expect(page.getByText('2 项工作', { exact: true })).toBeVisible();

  const workHubComposer = page.locator(
    '.workhub-surface .maka-composer-editor [contenteditable="true"]',
  );
  await workHubComposer.fill('继续这个工作，补充重复投递测试点。');
  await workHubComposer.press('Enter');
  const continuedTurn = page.locator('.workhub-turn', {
    hasText: '继续这个工作，补充重复投递测试点。',
  });
  await expect(
    continuedTurn.locator('.workhub-submitted-session strong'),
  ).toHaveText(sourceSessionName);

  await workHubComposer.fill('不是这个，换成登录稳定性，补充刷新令牌失败判定。');
  await expect(
    page.locator('.workhub-surface').getByRole('button', { name: '发送' }),
  ).toBeEnabled();
  await workHubComposer.press('Enter');

  const correctionTurn = page.locator('.workhub-turn', {
    hasText: '不是这个，换成登录稳定性，补充刷新令牌失败判定。',
  });
  await expect(correctionTurn.locator('.workhub-error')).toContainText(
    '跨 Session 更正将在持久委托关联完成后开放',
  );
  await expect(correctionTurn.locator('.workhub-submitted')).toHaveCount(0);
});
