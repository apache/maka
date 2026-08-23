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

test('Module Hub switches all four leaves and opens scheduled creation once', async ({
  window: page,
}) => {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.isVisible()) await expand.click();
  const sidebar = page.getByRole('navigation', { name: '任务列表' });

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  const extensions = page.getByRole('navigation', { name: /扩展内容/ });
  await extensions.getByRole('button', { name: 'MCP', exact: true }).click();
  await expect(
    extensions.getByRole('button', { name: 'MCP', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  await sidebar.getByRole('button', { name: /定时任务/ }).click();
  await expect(page.locator('[data-module="scheduled-tasks"]')).toBeVisible();
  const automations = page.getByRole('navigation', { name: /定时任务内容/ });
  await automations.getByRole('button', { name: '每日回顾', exact: true }).click();
  await expect(page.locator('[data-module="daily-review"]')).toBeVisible();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await palette.getByRole('option', { name: /新建定时任务/ }).click();

  const createDialog = page.getByRole('dialog', { name: '新建定时任务' });
  await expect(createDialog).toBeVisible();
  await expect(createDialog).toHaveCount(1);
  await expect(page.locator('[data-module="scheduled-tasks"]')).toBeVisible();
});
