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

test('expanded sidebar chrome follows Astryx toolbar geometry', async ({ window }) => {
  const sidebar = window.getByRole('navigation', { name: '任务列表' });
  const actions = window.locator('[data-maka-contract="shell-topbar-rail"]');
  const expandSidebar = window.getByRole('button', { name: '展开侧边栏' });

  if (await expandSidebar.isVisible()) await expandSidebar.click();
  await expect(window.getByRole('button', { name: '收起侧边栏' })).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(actions).toBeVisible();

  const sidebarBox = await sidebar.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(sidebarBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();

  const trailingInset = sidebarBox!.x + sidebarBox!.width - (actionsBox!.x + actionsBox!.width);
  expect(trailingInset).toBeGreaterThanOrEqual(0);
  expect(trailingInset).toBeLessThanOrEqual(16);
  await expect(actions).toHaveCSS('column-gap', '4px');
});
