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

import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import type { CDPSession, Locator, Page } from '@playwright/test';
import { awaitSendReady, ensureSidebarExpanded, expect, test, COMPOSER_INPUT } from './fixtures';
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

async function tabTo(page: Page, target: Locator, label: string, limit = 30): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  expect(
    await target.evaluate((element) => element === document.activeElement),
    `${label} is not reachable within ${limit} Tab presses`,
  ).toBe(true);
}

async function enterMainFromSkipLink(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.tabIndex = -1;
    document.body.focus();
  });
  const skipLink = page.getByRole('link', { name: '跳到主要内容' });
  await tabTo(page, skipLink, 'skip link', 10);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.evaluate(() => document.body.removeAttribute('tabindex'));
}

test('every settings page exposes named actionable controls', async ({ window: page }) => {
  await openSettings(page);
  const cdp = await page.context().newCDPSession(page);
  const navigation = page.getByRole('navigation', { name: '设置分组' });
  await expect(page.getByRole('main')).toHaveCount(1);
  const sectionLabels = (await navigation.getByRole('button').allTextContents())
    .map((label) => label.trim().replace(/\s*Beta$/, ''))
    .filter((label) => label.length > 0 && label !== '返回应用');
  const expectedSectionLabels = groupedNav('zh-CN')
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
  ).toHaveAttribute('aria-current', 'true');
  await assertAxHealth(cdp, 'extensions/skills');
  const mcpButton = extensionsNavigation.getByRole('button', { name: 'MCP', exact: true });
  await mcpButton.click();
  await expect(mcpButton).toHaveAttribute('aria-current', 'true');
  await assertAxHealth(cdp, 'extensions/mcp');

  await navigation.getByRole('button', { name: /定时任务/ }).click();
  const automationsNavigation = page.getByRole('navigation', { name: /定时任务内容/ });
  await expect(
    automationsNavigation.getByRole('button', { name: '定时任务', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await assertAxHealth(cdp, 'automations/scheduled-tasks');
  const dailyReviewButton = automationsNavigation.getByRole('button', {
    name: '每日回顾',
    exact: true,
  });
  await dailyReviewButton.click();
  await expect(dailyReviewButton).toHaveAttribute('aria-current', 'true');
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

test('data-backed conversation exposes ordered todos and keyboard access to tools, models, and Graph', async ({
  accessibilityNarrativeWindow: page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await expect(page.getByRole('region', { name: /对话：/ })).toBeVisible();
  const todoRegion = page.getByRole('region', { name: '任务待办' });
  await expect(todoRegion).toBeVisible();
  await expect(todoRegion.getByRole('listitem')).toHaveText([
    '补齐桌面端无障碍覆盖',
    '核对模型选择器的键盘路径',
    '确认工具结果可以展开阅读',
  ]);
  await assertAxHealth(cdp, 'conversation/data-backed');

  await expect(page.getByRole('main')).toHaveCount(1);
  await enterMainFromSkipLink(page);

  const toolCall = page.getByRole('button', { name: /^检查测试状态/ });
  await tabTo(page, toolCall, 'tool result');
  await page.keyboard.press('Enter');
  await expect(toolCall).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-slot="tool-output"]')).toContainText('core 41 passing');
  await assertAxHealth(cdp, 'conversation/tool-result-expanded');
  await page.keyboard.press('Enter');
  await expect(toolCall).toHaveAttribute('aria-expanded', 'false');

  const modelSwitcher = page.getByRole('button', { name: '切换当前任务模型' });
  await tabTo(page, modelSwitcher, 'model picker');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitemradio', { name: /glm-5\.1/ })).toBeVisible();
  await assertAxHealth(cdp, 'conversation/model-picker');
  const availableModel = page.getByRole('menuitemradio', { name: 'glm-4.5', exact: true });
  await expect(availableModel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(modelSwitcher).toContainText('glm-4.5');

  const composer = page.locator(COMPOSER_INPUT);
  await tabTo(page, composer, 'composer', 60);
  await page.keyboard.insertText('/graph on');
  const send = page.getByRole('button', { name: '发送' });
  await tabTo(page, send, 'Send button', 20);
  await awaitSendReady(page);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Graph Mode 已开启', { exact: true })).toBeVisible();
  await assertAxHealth(cdp, 'overlay/graph-mode-toast');

  const graphPanel = page.getByRole('region', { name: 'Agent Graph' });
  await expect(graphPanel).toBeVisible();
  await expect(graphPanel).toContainText('等待主 Agent 创建 operator…');
  const collapseGraph = graphPanel.getByRole('button', { name: '收起 Agent Graph' });
  await tabTo(page, collapseGraph, 'Graph collapse', 60);
  await page.keyboard.press('Enter');
  await expect(
    graphPanel.getByRole('button', { name: '展开 Agent Graph' }),
  ).toHaveAttribute('aria-expanded', 'false');
  await assertAxHealth(cdp, 'conversation/agent-graph-empty');
});

test('toast and error states expose healthy live regions', async ({ window: page }) => {
  const cdp = await page.context().newCDPSession(page);
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('/graph history');
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByText('Graph 历史', { exact: true })).toBeVisible();
  await assertAxHealth(cdp, 'overlay/graph-history-toast');

  await page.evaluate(async () => {
    await window.maka.connections.setDefaultModel(null);
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });
  const failure = page.getByRole('alert');
  await expect(failure).toContainText('WorkHub 暂时无法启动');
  await expect(failure).toContainText('请检查当前 Runtime Host 的默认模型配置');
  await assertAxHealth(cdp, 'workhub/startup-error');
});

test('a streaming answer exposes a healthy live conversation state', async ({ window: page }) => {
  const cdp = await page.context().newCDPSession(page);
  await enterMainFromSkipLink(page);
  const composer = page.locator(COMPOSER_INPUT);
  await tabTo(page, composer, 'streaming composer', 60);
  await page.keyboard.insertText(FAKE_HOLD_OPEN_PROMPT);
  const send = page.getByRole('button', { name: '发送' });
  // After the Tab walk, not before it: a tooltip-carrying Astryx Button is
  // disabled via `aria-disabled`, so it stays focusable and `tabTo` would
  // reach it either way.
  await tabTo(page, send, 'streaming Send button', 20);
  await awaitSendReady(page);
  await page.keyboard.press('Enter');

  await expect(page.locator('.maka-bubble-streaming')).toContainText(
    'Fake backend waiting',
    { timeout: 20_000 },
  );
  await expect(page.getByRole('button', { name: '停止' })).toBeEnabled();
  await assertAxHealth(cdp, 'conversation/streaming');

  const stop = page.getByRole('button', { name: '停止' });
  await tabTo(page, stop, 'streaming Stop button', 20);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await assertAxHealth(cdp, 'conversation/stopped');
});

test('composer and workbar entry points expose named actionable controls', async ({
  window: page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '新任务对话' })).toBeVisible();
  await assertAxHealth(cdp, 'conversation/new-task');

  await enterMainFromSkipLink(page);
  const composer = page.locator(COMPOSER_INPUT);
  const prompt = 'create a session for accessibility coverage';
  await tabTo(page, composer, 'new-task composer', 60);
  await page.keyboard.insertText(prompt);
  const send = page.getByRole('button', { name: '发送' });
  await tabTo(page, send, 'new-task Send button', 20);
  await awaitSendReady(page);
  await page.keyboard.press('Enter');
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
    if (panel === '终端') {
      await expect(page.getByRole('region', { name: '任务终端' })).toBeVisible();
    } else if (panel === '浏览器') {
      await expect(page.getByRole('region', { name: '嵌入式浏览器' })).toBeVisible();
    } else if (panel === '待办') {
      await expect(page.getByRole('region', { name: '任务待办' })).toBeVisible();
    }
    await assertAxHealth(cdp, `workbar/${panel}`);
    if (panel !== workbarPanels.at(-1)) {
      await page.getByRole('button', { name: '打开工作栏标签' }).first().click();
      await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
    }
  }
});

/**
 * Restoring a draft is not a reason to move focus. The composer places the
 * restored caret with a selection, and a selection inside a `contenteditable`
 * focuses it whatever held focus before — so before the caret was held back,
 * activating a session row took focus out from under the keyboard user who
 * activated it. Asserted in a real browser because that is where the focus
 * side effect lives; the unit harness models it and cannot observe it.
 */
test('activating a session row with an unsent draft keeps focus on the row', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const prompt = 'session for the draft focus contract';
  await composer.fill(prompt);
  await awaitSendReady(page);
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${prompt}`)).toBeVisible({
    timeout: 30_000,
  });

  await composer.click();
  // Plain text, no Skill token: this contract is about the caret restore, and a
  // token redraw writes the same selection for a reason of its own.
  await page.keyboard.insertText('an unsent draft');
  await expect(composer).toHaveText('an unsent draft');

  await ensureSidebarExpanded(page);
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  const sessionRow = sidebar.locator('[data-session-id]').first();
  await sessionRow.click();
  await expect(composer).toHaveText('an unsent draft');
  await expect(composer).not.toBeFocused();
  await expect(sessionRow.locator(':focus')).toHaveCount(1);
});
