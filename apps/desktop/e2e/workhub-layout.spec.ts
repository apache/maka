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

  await expect(page.getByRole('region', { name: 'WorkHub' })).toBeVisible();
  await expect(page.locator('.workhub-empty')).toContainText('从这里继续所有工作');
  await expect(page.locator('.workhub-surface .maka-composer-editor')).toBeVisible();
});
