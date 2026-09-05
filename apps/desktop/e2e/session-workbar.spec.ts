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

import { COMPOSER_INPUT, test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function openGitChanges(page: Page) {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create review session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create review session/)).toBeVisible();
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await page.getByRole('button', { name: /变更.*查看当前 Git 工作区变化/ }).click();
  return page.getByRole('region', { name: 'Git 变更' });
}

async function createSession(page: Page, prompt: string) {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${prompt}`)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  const expandSidebar = page.getByRole('button', { name: '展开侧边栏' });
  if (await expandSidebar.isVisible()) await expandSidebar.click();
  const sessionId = await sidebar
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  return { composer, sessionId: sessionId!, sidebar };
}

test('the composer usage action opens Task trace in the right workbar', async ({
  accessibilityNarrativeWindow: page,
}) => {
  const action = page.getByRole('button', { name: '打开用量追踪' });
  await expect(action).toBeVisible();

  await action.click();

  const rightPanel = page.locator(
    '.maka-session-workbar-panel[data-overlay][data-placement="right"]',
  );
  await expect(
    rightPanel.locator('[data-maka-contract="session-inspector"]'),
  ).toBeVisible();
});

test('a collapsed workbar never flashes during the first send', async ({
  window: page,
}) => {
  await page.evaluate(() => {
    const watch = { visibleRightWorkbar: false };
    const inspect = () => {
      const panel = document.querySelector<HTMLElement>(
        '.maka-session-workbar[data-placement="right"]',
      );
      if (
        panel &&
        getComputedStyle(panel).display !== 'none' &&
        panel.getBoundingClientRect().width > 0
      ) {
        watch.visibleRightWorkbar = true;
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    (
      window as typeof window & {
        __makaFirstSendWorkbarWatch?: typeof watch;
        __makaFirstSendWorkbarWatchStop?: () => void;
      }
    ).__makaFirstSendWorkbarWatch = watch;
    (
      window as typeof window & {
        __makaFirstSendWorkbarWatchStop?: () => void;
      }
    ).__makaFirstSendWorkbarWatchStop = () => {
      inspect();
      observer.disconnect();
    };
  });

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session without opening the workbar');
  await page.getByRole('button', { name: '发送' }).click();
  const expandWorkbar = page.getByRole('button', { name: '展开任务工作栏' });
  await expect(expandWorkbar).toBeVisible({
    timeout: 20_000,
  });

  const watch = await page.evaluate(() => {
    const target = window as typeof window & {
      __makaFirstSendWorkbarWatch?: { visibleRightWorkbar: boolean };
      __makaFirstSendWorkbarWatchStop?: () => void;
    };
    target.__makaFirstSendWorkbarWatchStop?.();
    return target.__makaFirstSendWorkbarWatch;
  });
  expect(watch?.visibleRightWorkbar, 'the collapsed right workbar stayed hidden').toBe(false);

  await expandWorkbar.evaluate((button) => button.click());
  await expect(
    page.locator('.maka-session-workbar[data-placement="right"]'),
  ).toBeVisible();
});

async function waitForCompanionForkId(page: Page, sourceSessionId: string) {
  let forkId: string | undefined;
  await expect
    .poll(async () => {
      forkId = (await page.evaluate(() => window.maka.sessions.list())).find(
        (session) => session.id !== sourceSessionId,
      )?.id;
      return forkId;
    })
    .not.toBeUndefined();
  return forkId!;
}

test('titlebar workbar action restores an existing tool instead of the picker', async ({
  gitReviewWindow,
}) => {
  const page = gitReviewWindow.page;
  const workspaceActions = page.getByRole('toolbar', { name: '工作区辅助操作' });
  const panel = await openGitChanges(page);
  const panelToolbar = page.getByRole('toolbar', { name: '任务工作栏标签' }).first();
  const collapseButton = panelToolbar.getByRole('button', { name: '收起任务工作栏' });
  await expect(workspaceActions).toHaveCount(0);
  await expect(collapseButton).toBeVisible();
  await expect(workspaceActions.getByRole('button', { name: '打开工作栏工具' })).toHaveCount(0);

  const activeTab = panelToolbar.getByRole('tab', { selected: true });
  await expect(activeTab).toBeVisible();
  const [toolbarBox, tabBox, toggleBox] = await Promise.all([
    panelToolbar.boundingBox(),
    activeTab.boundingBox(),
    collapseButton.boundingBox(),
  ]);
  expect(toolbarBox).not.toBeNull();
  expect(tabBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(
    Math.abs(tabBox!.y + tabBox!.height / 2 - (toggleBox!.y + toggleBox!.height / 2)),
  ).toBeLessThanOrEqual(1);

  const simulatedCaptionWidth = 80;
  await page.evaluate((width) => {
    document.documentElement.style.setProperty(
      '--maka-titlebar-overlay-right-width',
      `${width}px`,
    );
  }, simulatedCaptionWidth);
  await expect
    .poll(async () => (await collapseButton.boundingBox())?.x)
    .toBe(toggleBox!.x - simulatedCaptionWidth);
  const safeAreaToggleBox = await collapseButton.boundingBox();
  expect(safeAreaToggleBox).not.toBeNull();

  // [+] is a menu over the panel now, not a swap to the launcher: the face you
  // are reading stays on screen while you pick another one.
  await page.getByRole('button', { name: '打开或关闭工作栏的面' }).click();
  const faceMenu = page.getByRole('menu');
  await expect(faceMenu).toBeVisible();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(faceMenu).toBeHidden();
  const picker = page.getByRole('list', { name: '打开工具' });
  await expect(picker).not.toBeVisible();

  await collapseButton.click();
  const expandButton = workspaceActions.getByRole('button', { name: '展开任务工作栏' });
  await expect(expandButton).toBeVisible();
  const expandButtonBox = await expandButton.boundingBox();
  expect(expandButtonBox).not.toBeNull();
  expect(Math.abs(expandButtonBox!.y - safeAreaToggleBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(expandButtonBox!.x - safeAreaToggleBox!.x)).toBeLessThanOrEqual(1);
  await expandButton.click();

  await expect(panel).toBeVisible();
  await expect(picker).not.toBeVisible();
  const restoredCollapseButton = panelToolbar.getByRole('button', {
    name: '收起任务工作栏',
  });
  await expect(restoredCollapseButton).toBeVisible();
  const restoredToggleBox = await restoredCollapseButton.boundingBox();
  expect(restoredToggleBox).not.toBeNull();
  expect(Math.abs(restoredToggleBox!.y - safeAreaToggleBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(restoredToggleBox!.x - safeAreaToggleBox!.x)).toBeLessThanOrEqual(1);
});

test('Git changes re-read the workspace after the app regains focus', async ({
  gitReviewWindow,
}) => {
  const panel = await openGitChanges(gitReviewWindow.page);
  await expect(panel.getByText('新增 4 行')).toBeVisible();

  await writeFile(join(gitReviewWindow.projectRoot, 'base.txt'), 'base\nunstaged\nexternal\n');
  await gitReviewWindow.page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(panel.getByText('新增 5 行')).toBeVisible();
});

test('Terminal ownership follows the active Session and stops the old resource', async ({
  window: page,
}) => {
  const { composer, sessionId, sidebar } = await createSession(
    page,
    'create terminal owner session',
  );
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await page
    .getByRole('button', { name: /终端.*查看当前任务的终端运行和实时输出/ })
    .click();

  const terminal = page.getByRole('region', { name: '任务终端' });
  await expect(terminal).toBeVisible();
  const terminalRef = await terminal.getAttribute('data-terminal-ref');
  expect(terminalRef).toBeTruthy();
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.maka.shellRuns.list(id), sessionId))
        .find((update) => update.result.ref === terminalRef)
        ?.result.status,
    )
    .toBe('running');

  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(terminal).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate((id) => window.maka.shellRuns.list(id), sessionId))
        .find((update) => update.result.ref === terminalRef)
        ?.result.status,
    )
    .not.toBe('running');

  await composer.fill('create replacement session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: create replacement session')).toBeVisible();
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
});

test('Side Chat survives collapse, confirms close, and cleans up on source switch', async ({
  window: page,
}) => {
  const { composer, sessionId, sidebar } = await createSession(
    page,
    'create side chat source session',
  );
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  const openSideChat = page.getByRole('button', {
    name: /侧边对话.*在不打断主任务的情况下追问和只读探索/,
  });
  await openSideChat.click();

  const companion = page.locator('.maka-quote-companion');
  await expect(companion).toBeVisible();

  // The companion forks lazily on the first send, not when the panel opens.
  const sideComposer = companion.locator(COMPOSER_INPUT);
  await sideComposer.fill('inspect this source without changing it');
  await sideComposer.press('Enter');
  await expect(companion).toContainText(
    'Fake backend received: inspect this source without changing it',
  );
  const firstForkId = await waitForCompanionForkId(page, sessionId);
  await expect(sidebar.locator(`[data-session-id=${JSON.stringify(firstForkId)}]`)).toHaveCount(0);

  await page.getByRole('button', { name: '收起任务工作栏' }).click();
  await expect(companion).toBeAttached();
  await expect(companion).not.toBeVisible();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.sessions.list()))
        .some((session) => session.id === firstForkId),
    )
    .toBe(true);
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(companion).toBeVisible();

  // Closing is the same [+] menu that opens: the face already on screen carries
  // a checkmark, and picking it again asks to close it.
  const closeActiveSideChat = async () => {
    await page.getByRole('button', { name: '打开或关闭工作栏的面' }).first().click();
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: '侧边对话', exact: true })
      .click();
  };
  await closeActiveSideChat();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toContainText('这个临时侧边对话会被永久删除');
  await confirmation.getByRole('button', { name: '取消' }).click();
  await expect(companion).toBeVisible();

  await closeActiveSideChat();
  await confirmation.getByRole('button', { name: '关闭侧边对话' }).click();
  await expect(companion).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.sessions.list()))
        .some((session) => session.id === firstForkId),
    )
    .toBe(false);

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await openSideChat.click();
  await expect(companion).toBeVisible();
  // Fork again on the reopened panel's first send.
  const reopenedComposer = companion.locator(COMPOSER_INPUT);
  await reopenedComposer.fill('inspect once more before switching away');
  await reopenedComposer.press('Enter');
  await expect(companion).toContainText(
    'Fake backend received: inspect once more before switching away',
  );
  const secondForkId = await waitForCompanionForkId(page, sessionId);

  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(companion).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.sessions.list()))
        .some((session) => session.id === secondForkId),
    )
    .toBe(false);
  await expect(composer).toHaveText('');
});
