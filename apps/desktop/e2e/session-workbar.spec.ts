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

async function setRightWorkbarWidth(page: Page, width: number) {
  const workbar = page.locator('.maka-session-workbar[data-placement="right"]');
  await expect(workbar).toBeVisible();
  await workbar.evaluate((element, nextWidth) => {
    (element as HTMLElement).style.setProperty(
      '--maka-session-workbar-width',
      `${nextWidth}px`,
    );
  }, width);
  await expect
    .poll(async () => (await workbar.boundingBox())?.width)
    .toBeCloseTo(width, 0);
  return workbar;
}

test('narrow right workbar keeps launcher shortcuts and side-chat send button inside', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create narrow workbar session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create narrow workbar session/)).toBeVisible();

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  const launcher = page.getByRole('list', { name: '打开工具' });
  await expect(launcher).toBeVisible();
  const workbar = await setRightWorkbarWidth(page, 320);

  const workbarBox = await workbar.boundingBox();
  const shortcutBoxes = await launcher
    .locator('kbd')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
  expect(workbarBox).not.toBeNull();
  expect(shortcutBoxes.length).toBeGreaterThan(0);
  for (const shortcutBox of shortcutBoxes) {
    expect.soft(shortcutBox.left).toBeGreaterThanOrEqual(workbarBox!.x);
    expect.soft(shortcutBox.right).toBeLessThanOrEqual(workbarBox!.x + workbarBox!.width);
  }

  await page
    .getByRole('button', {
      name: /侧边对话.*在不打断主任务的情况下追问和只读探索/,
    })
    .click();
  const companion = page.locator('.maka-quote-companion');
  await expect(companion).toBeVisible();
  await setRightWorkbarWidth(page, 320);

  const composerCard = companion.locator('.maka-composer-astryx');
  // Keep ChatComposer's inner elevation visible.
  await expect(composerCard).toHaveCSS('overflow', 'visible');

  // #3452: Side Chat is a branch of the main conversation, not a second
  // conversation surface, so its dock rounds like the main dock. Both resolve
  // Astryx's `--radius-chat`, the same token `ChatMessageBubble` defaults to —
  // a side-only `--_chat-composer-radius` split the bubble from the dock the
  // moment the bubbles moved back to that default. Compared against the main
  // composer rather than a literal so an upstream token change moves both or
  // fails here.
  const composerRadii = await page.evaluate(() => {
    const wrappers = [...document.querySelectorAll('.maka-composer-astryx')];
    const inCompanion = (element: Element) => element.closest('.maka-quote-companion') !== null;
    const effectiveRadius = (element: Element | undefined) => {
      if (!element) return null;
      const styles = getComputedStyle(element);
      return (
        styles.getPropertyValue('--_chat-composer-radius').trim() ||
        styles.getPropertyValue('--radius-chat').trim()
      );
    };
    return {
      side: effectiveRadius(wrappers.find(inCompanion)),
      main: effectiveRadius(wrappers.find((element) => !inCompanion(element))),
    };
  });
  expect(composerRadii.side).toBeTruthy();
  expect(composerRadii.side).toBe(composerRadii.main);
  // Match the long model-label pressure from the reported side-chat screenshot
  // without coupling the fixture's globally useful default model to this test.
  await companion.locator('.maka-composer-model-chip-text').evaluate((element) => {
    element.textContent = 'Nemotron 3 Ultra Long Context Model';
  });
  const sendButton = companion.getByRole('button', { name: '发送' });
  await expect(sendButton).toBeVisible();
  const [composerBox, sendBox] = await Promise.all([
    composerCard.boundingBox(),
    sendButton.boundingBox(),
  ]);
  expect(composerBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(sendBox!.x).toBeGreaterThanOrEqual(composerBox!.x);
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(
    composerBox!.x + composerBox!.width,
  );
});

// #2188: the address field, not the nav buttons, absorbs the column's free
// width. The rule reaches into Astryx Toolbar's slot div, which nothing else
// pins — an upstream slot-wrapper change would silently regress it.
test('browser address field tracks the workbar column width', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create browser session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create browser session/)).toBeVisible();
  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await page.getByRole('button', { name: /浏览器.*打开内置浏览器/ }).click();
  await expect(page.getByRole('region', { name: '嵌入式浏览器' })).toBeVisible();

  const addressInput = page.getByRole('textbox', { name: '浏览器地址' });
  const inputWidth = async () => (await addressInput.boundingBox())!.width;
  // The tab's content lives in the overlay panel next to the workbar frame,
  // so the width override must land there, not on `.maka-session-workbar`.
  const setPanelWidth = async (width: number) => {
    const panel = page.locator('.maka-session-workbar-panel[data-overlay][data-placement="right"]');
    await panel.evaluate((element, nextWidth) => {
      (element as HTMLElement).style.setProperty('--maka-session-workbar-width', `${nextWidth}px`);
    }, width);
    await expect.poll(async () => (await panel.boundingBox())?.width).toBeCloseTo(width, 0);
  };
  await setPanelWidth(480);
  await expect.poll(inputWidth).toBeGreaterThan(250);
  await setPanelWidth(320);
  // Fails at a flat width without the slot rule: 480 and 320 would measure the same.
  await expect.poll(inputWidth).toBeLessThan(220);
  await expect.poll(inputWidth).toBeGreaterThan(100);
});

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

  await page.getByRole('button', { name: '打开工作栏标签' }).click();
  const picker = page.getByRole('list', { name: '打开工具' });
  await expect(picker).toBeVisible();

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
