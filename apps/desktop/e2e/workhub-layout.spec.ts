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

import { expect, test, COMPOSER_INPUT } from './fixtures';

test('WorkHub target metadata does not overlap the submitted Session result', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('支付回调幂等性');
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
  await expect(page.getByText('1 项工作', { exact: true })).toBeVisible();

  const workHubComposer = page.locator(
    '.workhub-surface .maka-composer-editor [contenteditable="true"]',
  );
  await workHubComposer.fill(`继续${sessionName}，补充重复投递测试点。`);
  await workHubComposer.press('Enter');
  await expect(page.locator('.workhub-result')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const button = document.querySelector<HTMLElement>('.workhub-submitted > button')!;
    const project = button.querySelector<HTMLElement>('.workhub-submitted-session small')!;
    const result = document.querySelector<HTMLElement>('.workhub-result')!;
    const buttonBox = button.getBoundingClientRect();
    const projectBox = project.getBoundingClientRect();
    const resultBox = result.getBoundingClientRect();
    return {
      buttonContainsProject: buttonBox.bottom >= projectBox.bottom,
      overlapHeight:
        Math.min(projectBox.bottom, resultBox.bottom) - Math.max(projectBox.top, resultBox.top),
    };
  });

  expect(geometry.buttonContainsProject).toBe(true);
  expect(geometry.overlapHeight).toBeLessThanOrEqual(0);
});

test('WorkHub explains Coordination startup failure and recovers after a default model is set', async ({
  window: page,
}) => {
  await page.evaluate(async () => {
    await window.maka.connections.setDefaultModel(null);
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });

  const failure = page.getByRole('alert');
  await expect(failure).toContainText('WorkHub 暂时无法启动');
  await expect(failure).toContainText('请检查当前 Runtime Host 的默认模型配置');

  await page.evaluate(async () => {
    await window.maka.connections.setDefaultModel({
      slug: 'e2e',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  await expect(page.getByRole('main', { name: 'WorkHub' })).toBeVisible();
  await expect(page.locator('.workhub-empty')).toContainText('从这里继续所有工作');
  await expect(page.locator('.workhub-surface .maka-composer-editor')).toBeVisible();
});
