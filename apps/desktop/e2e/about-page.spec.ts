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

test('About renders channel facts, update status, support, and privacy', async ({ window: page }) => {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '关于', exact: true }).click();

  // The channel token must agree with the version string: the fixture app is a
  // dev checkout, so it reads 本地开发版, never 正式版.
  await expect(page.getByText('本地开发版', { exact: true })).toBeVisible();
  await expect(page.getByText('正式版')).toHaveCount(0);
  await expect(page.getByText('本地开发构建，不检查更新。')).toBeVisible();

  // Dev builds do not poll GitHub releases; the status line in the lead says
  // why instead of pretending "已是最新版本", and the check stays disabled.
  await expect(page.getByText('本地开发版不检查 GitHub 发布更新。请使用正式安装包。')).toBeVisible();
  await expect(page.getByRole('button', { name: '检查更新' })).toBeDisabled();

  // Support lives outside the info conditional: usable even when `app.info`
  // fails, which is exactly when a user reaches for it.
  await expect(page.getByRole('heading', { name: '支持', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '查看' })).toBeEnabled();

  // Three commitments, not the old wall of five bullets.
  const privacyList = page.getByRole('list', { name: '隐私承诺' });
  await expect(privacyList.getByRole('listitem')).toHaveCount(3);
});