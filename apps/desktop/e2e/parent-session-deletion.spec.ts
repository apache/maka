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

import {
  expect,
  PARENT_REMOVAL_CHILD_NAME,
  PARENT_REMOVAL_PARENT_NAME,
  test,
} from './fixtures';

/**
 * The route is two steps on purpose: the rail archives, Settings deletes. The
 * rail has no delete at all — a mis-click there is one hover away from an
 * irreversible loss — so a task must have been archived once before anything
 * can remove it. This walks the whole route rather than calling the command,
 * because the route is the thing that changed.
 */
test('deleting a parent task archives its linked subagent task', async ({
  parentRemovalWindow: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const taskList = page.getByRole('navigation', { name: '任务列表' });
  const parentRow = taskList
    .locator('[data-maka-contract="session-row"]')
    .filter({ hasText: PARENT_REMOVAL_PARENT_NAME });

  await expect(parentRow).toHaveCount(1);
  await expect(taskList.getByText(PARENT_REMOVAL_CHILD_NAME, { exact: true })).toHaveCount(0);

  await parentRow.hover();
  await parentRow.getByRole('button', { name: '任务操作' }).click();
  // The rail's menu ends at 归档. Deleting is not one of the things a row can
  // be asked to do here.
  await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: '归档', exact: true }).click();
  await expect(parentRow).toHaveCount(0);

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.getByRole('button', { name: '已归档任务', exact: true }).click();
  const archivedTasks = page.getByRole('main', { name: '设置内容' });

  await archivedTasks
    .getByRole('button', { name: `「${PARENT_REMOVAL_PARENT_NAME}」的更多操作` })
    .click();
  // 彻底删除, not 删除: Settings names the irreversible verb in full, which is
  // the point of routing every deletion through a surface reached by archiving.
  await page.getByRole('menuitem', { name: '彻底删除', exact: true }).click();
  const confirm = page.getByRole('alertdialog', {
    name: `删除 "${PARENT_REMOVAL_PARENT_NAME}"`,
  });
  await expect(confirm).toBeVisible();
  // The confirm warns that the linked subtask is kept and archived rather than
  // destroyed, so the archived row that appears next is not a surprise. It names
  // no count — the Host owns the exact number and reports it in the toast.
  await expect(confirm.getByText(/子任务.*归档/)).toBeVisible();
  await confirm.getByRole('button', { name: '删除', exact: true }).click();

  await expect(archivedTasks.getByText(PARENT_REMOVAL_CHILD_NAME, { exact: true })).toBeVisible();
  await expect(archivedTasks.getByText(/原父任务已删除/)).toBeVisible();
  await expect(archivedTasks.getByText(PARENT_REMOVAL_PARENT_NAME, { exact: true })).toHaveCount(0);
});
