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

import type { CDPSession, Page } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';
import { auditAxTree } from '../../../scripts/ax-tree-audit.mjs';
import { groupedNav } from '../src/renderer/settings/settings-nav';

function exactNameWithOptionalBadge(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?: Beta)?$`);
}

async function assertAxHealth(cdp: CDPSession, surface: string): Promise<void> {
  const result = await cdp.send('Accessibility.getFullAXTree');
  const audit = auditAxTree(result.nodes);
  expect(audit.problems, `${surface} exposes an unhealthy AX tree`).toEqual([]);
}

async function openSettings(page: Page): Promise<void> {
  const sidebarToggle = page.getByRole('button', { name: '展开侧边栏' });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
}

test('every settings page exposes named actionable controls', async ({ window: page }) => {
  await openSettings(page);
  const cdp = await page.context().newCDPSession(page);
  const navigation = page.getByRole('navigation', { name: '设置分组' });
  await expect(page.getByRole('main')).toHaveCount(1);
  const sectionLabels = (await navigation.getByRole('button').allTextContents())
    .map((label) => label.trim().replace(/\s*Beta$/, ''))
    .filter((label) => label.length > 0 && label !== '返回应用');
  const expectedSectionLabels = groupedNav('zh')
    .flatMap(({ items }) => items)
    .filter(({ enabled }) => enabled)
    .map(({ label }) => label);
  expect(sectionLabels, 'settings navigation must expose every enabled page in source order').toEqual(
    expectedSectionLabels,
  );

  for (const section of sectionLabels) {
    const sectionButton = navigation.getByRole('button', {
      name: exactNameWithOptionalBadge(section),
    });
    await sectionButton.click();
    await expect(sectionButton).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
    await assertAxHealth(cdp, `settings/${section}`);
  }
});

test('module pages and global overlays expose named actionable controls', async ({
  window: page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await expect(page.getByRole('link', { name: '跳到主要内容' })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveCount(0);
  const sidebarToggle = page.getByRole('button', { name: '展开侧边栏' });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  const navigation = page.getByRole('navigation', { name: '任务列表' });

  await navigation.getByRole('button', { name: '扩展', exact: true }).click();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '扩展', exact: true })).toBeVisible();
  const extensionsNavigation = page.getByRole('navigation', { name: /扩展内容/ });
  await expect(
    extensionsNavigation.getByRole('button', { name: '技能', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await assertAxHealth(cdp, 'extensions/skills');
  const mcpButton = extensionsNavigation.getByRole('button', { name: 'MCP', exact: true });
  await mcpButton.click();
  await expect(mcpButton).toHaveAttribute('aria-current', 'page');
  await assertAxHealth(cdp, 'extensions/mcp');

  await navigation.getByRole('button', { name: /定时任务/ }).click();
  const automationsNavigation = page.getByRole('navigation', { name: /定时任务内容/ });
  await expect(
    automationsNavigation.getByRole('button', { name: '定时任务', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await assertAxHealth(cdp, 'automations/scheduled-tasks');
  const dailyReviewButton = automationsNavigation.getByRole('button', {
    name: '每日回顾',
    exact: true,
  });
  await dailyReviewButton.click();
  await expect(dailyReviewButton).toHaveAttribute('aria-current', 'page');
  await assertAxHealth(cdp, 'automations/daily-review');

  await page.keyboard.press('Shift+Slash');
  const keyboardHelpDialog = page.getByRole('dialog', { name: '键盘快捷键' });
  await expect(keyboardHelpDialog).toBeVisible();
  await assertAxHealth(cdp, 'overlay/keyboard-help');
  await page.keyboard.press('Escape');
  await expect(keyboardHelpDialog).toBeHidden();

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const commandPaletteDialog = page.getByRole('dialog', { name: '命令面板' });
  await expect(commandPaletteDialog).toBeVisible();
  await assertAxHealth(cdp, 'overlay/command-palette');
  await page.keyboard.press('Escape');
});

test('composer and workbar entry points expose named actionable controls', async ({
  window: page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '新任务对话' })).toBeVisible();
  await assertAxHealth(cdp, 'conversation/new-task');

  const composer = page.locator(COMPOSER_INPUT);
  const prompt = 'create a session for accessibility coverage';
  await composer.fill(prompt);
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${prompt}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('region', { name: /对话：/ })).toBeVisible();
  await assertAxHealth(cdp, 'conversation/session');

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await assertAxHealth(cdp, 'workbar/launcher');

  const workbarPanels = [
    '侧边对话',
    '变更',
    '终端',
    '浏览器',
    '生成文件',
    '待办',
    '追踪',
  ] as const;
  for (const panel of workbarPanels) {
    await page
      .getByRole('list', { name: '打开工具' })
      .getByRole('button', { name: new RegExp(`^${panel}(?: |$)`) })
      .click();
    const activeTab = page.getByRole('tab', { name: new RegExp(panel) });
    await expect(activeTab).toBeVisible();
    await expect(activeTab).toHaveAttribute('aria-selected', 'true');
    await assertAxHealth(cdp, `workbar/${panel}`);
    if (panel !== workbarPanels.at(-1)) {
      await page.getByRole('button', { name: '打开工作栏标签' }).first().click();
      await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
    }
  }
});
