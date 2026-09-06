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

// Real path: 设置 → 使用统计 → 定价配置. The editable Pricing tab (#2015 / PR #4164,
// integrated into the features/usage slice) reads ONE Host-backed effective
// pricing snapshot from the real embedded Runtime Host — no bridge stub. Per the
// maintainer direction on #2218 the surface is OVERRIDES-ONLY: the table lists
// only the user's custom rows, and the ~1.4k built-in catalog is reached only
// through the Add flow's Typeahead picker (never rendered as a table, so nothing
// heavy renders). This exercises #2015 acceptance #2 (the tab is not time-scoped:
// the Usage date range/summary toolbar is gone) and #11 (dialogs return focus to
// a stable control, including when reset/delete removes the opening row action —
// real Electron focus the linkedom harness cannot honestly exercise), plus the
// overrides-only shape and the picker/manual Add UI.
test('pricing tab is overrides-only with a catalog-picker Add flow, is not time-scoped, and restores focus', async ({
  window: page,
}) => {
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();

  await page.getByRole('button', { name: '使用统计', exact: true }).click();
  // The Usage tabs render as a `navigation` (named by the view's aria-label)
  // whose tabs are `button`s.
  await page
    .getByRole('navigation', { name: '使用统计视图' })
    .getByRole('button', { name: '定价配置', exact: true })
    .click();

  // The Pricing panel owns its own explanatory copy and its own Add control,
  // instead of the Usage range chrome. An enabled Add proves the snapshot loaded.
  await expect(page.getByText('美元 / 每百万 token。', { exact: false })).toBeVisible();
  const addButton = page.getByRole('button', { name: '添加定价' });
  await expect(addButton).toBeEnabled();

  // #2015 acceptance #2: the Usage range + summary toolbar must be absent on the
  // Pricing tab so the Usage date range cannot read as a Pricing scope.
  await expect(page.getByRole('group', { name: '使用统计范围与刷新' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '使用统计汇总指标' })).toHaveCount(0);

  // Overrides-only: the built-in catalog is never listed as table rows, so no
  // 来源 = 内置 cell appears anywhere on the panel (holds whether the Host has
  // zero or many overrides).
  await expect(page.getByText('内置', { exact: true })).toHaveCount(0);

  // The Add flow opens in catalog mode and offers a manual-entry fallback;
  // switching to it reveals the free-text key inputs for a model not in the
  // catalog.
  await addButton.click();
  const editor = page.getByRole('dialog', { name: '添加定价' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '模型不在列表中？手动输入' }).click();
  await expect(editor.getByRole('textbox', { name: '模型键' })).toBeVisible();

  // #2015 acceptance #11: closing the editor returns focus to the trigger.
  await editor.getByRole('button', { name: '取消' }).click();
  await expect(editor).toHaveCount(0);
  await expect(addButton).toBeFocused();

  // A successful delete removes the row action that opened its dialog. Focus
  // must land on the stable Add control instead of falling back to <body>.
  const focusModelKey = `e2e:pricing-focus-${Date.now()}`;
  await addButton.click();
  const addEditor = page.getByRole('dialog', { name: '添加定价' });
  await addEditor.getByRole('button', { name: '模型不在列表中？手动输入' }).click();
  await addEditor.getByRole('textbox', { name: /模型键/ }).fill(focusModelKey);
  await addEditor.getByRole('spinbutton', { name: /输入价格/ }).fill('1');
  await addEditor.getByRole('spinbutton', { name: /输出价格/ }).fill('2');
  await addEditor.getByRole('button', { name: '保存' }).click();
  await expect(addEditor).toHaveCount(0);
  await expect(page.getByText(focusModelKey, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: `删除「${focusModelKey}」定价` }).click();
  const deleteDialog = page.getByRole('alertdialog', { name: '删除定价' });
  await deleteDialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByText(focusModelKey, { exact: true })).toHaveCount(0);
  await expect(addButton).toBeFocused();
});
