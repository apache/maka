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

import { test, expect, COMPOSER_INPUT } from './fixtures';

interface SettingsChunkLatchWindow extends Window {
  makaE2eLatch?: {
    arm(key: 'settings.chunk'): void;
    release(key: 'settings.chunk'): void;
  };
}

async function choiceContentGeometry(card: import('@playwright/test').Locator) {
  return card.evaluate((element) => {
    const content = Array.from(element.children).find((child) => child.tagName !== 'INPUT');
    if (!(content instanceof HTMLElement)) {
      throw new Error('SelectableCard content is missing');
    }
    const cardRect = element.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      cardHeight: cardRect.height,
      contentHeight: contentRect.height,
      topGap: contentRect.top - cardRect.top,
      bottomGap: cardRect.bottom - contentRect.bottom,
    };
  });
}

test('Settings loading surface owns unmodified Escape', async ({ window: page }) => {
  const latchInstalled = await page.evaluate(() => {
    const e2eLatch = (window as unknown as SettingsChunkLatchWindow).makaE2eLatch;
    e2eLatch?.arm('settings.chunk');
    return e2eLatch !== undefined;
  });
  expect(latchInstalled, 'the preload E2E latch is installed').toBe(true);

  try {
    await page.getByRole('button', { name: '设置' }).click();

    const loadingSurface = page.locator('.maka-lazy-fallback');
    await expect(loadingSurface).toBeVisible();

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const wasNotPrevented = await page.evaluate((key) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            [key]: true,
            bubbles: true,
            cancelable: true,
          }),
        ), modifier);
      expect(wasNotPrevented).toBe(true);
      await expect(loadingSurface).toBeVisible();
    }

    const wasNotPrevented = await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(wasNotPrevented).toBe(false);
    await expect(page.locator('.settingsModal')).toHaveCount(0);
  } finally {
    await page.evaluate(() =>
      (window as unknown as SettingsChunkLatchWindow).makaE2eLatch?.release(
        'settings.chunk',
      ),
    );
  }
});

test('opening settings commits an active titlebar rename', async ({ window: page }) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session for settings rename');
  await composer.press('Enter');

  const identity = page.locator('[data-maka-contract="titlebar-identity"]');
  await expect(identity).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await identity.getByRole('button', { name: /重命名任务/ }).click();
  await page.getByRole('textbox', { name: '重命名任务' }).fill('renamed before settings');

  // Programmatic activation preserves input focus, matching the macOS
  // application-menu command that opens Settings before Chromium can blur it.
  await page.getByRole('button', { name: '设置' }).evaluate((button) => button.click());
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(identity).toContainText('renamed before settings');
});

test('settings hides expanded workbar chrome and restores it on close', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create a session with an expanded workbar');
  await composer.press('Enter');

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  const workbar = page.locator('.maka-session-workbar[data-placement="right"]');
  const workbarToolbar = workbar.getByRole('toolbar', { name: '任务工作栏标签' });
  await expect(workbarToolbar).toBeVisible();
  await expect(workbarToolbar.getByRole('button', { name: '打开工作栏标签' })).toBeVisible();
  await expect(workbarToolbar.getByRole('button', { name: '收起任务工作栏' })).toBeVisible();
  await page
    .getByRole('button', { name: /待办.*查看和维护这个任务的待办台账/ })
    .click();
  const taskTab = workbarToolbar.getByRole('tab', { name: '待办' });
  await expect(taskTab).toBeVisible();

  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await expect(workbar).not.toBeVisible();

  await page.keyboard.press('Escape');
  await expect(workbarToolbar).toBeVisible();
  await expect(taskTab).toBeVisible();
});

test('wide settings gutters scroll the whole main pane', async ({ window: page }) => {
  await page.setViewportSize({ width: 1600, height: 520 });
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();

  const pane = page.locator('.settingsMainPane');
  const content = pane.locator('.settingsPageStack').first();
  const geometry = await pane.evaluate((element) => {
    const paneRect = element.getBoundingClientRect();
    const contentElement = element.querySelector('.settingsPageStack');
    const contentRect = contentElement?.getBoundingClientRect();
    const layoutContent = element.querySelector('.astryx-layout-content');
    if (!contentRect || !layoutContent) throw new Error('Settings layout is incomplete');
    return {
      blankRight: paneRect.right - contentRect.right,
      clientHeight: element.clientHeight,
      contentOverflowY: getComputedStyle(layoutContent).overflowY,
      paneOverflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      wheelPoint: {
        x: Math.floor((contentRect.right + paneRect.right) / 2),
        y: Math.floor(Math.min(contentRect.top + 120, paneRect.bottom - 40)),
      },
    };
  });

  expect(geometry.blankRight).toBeGreaterThan(40);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.contentOverflowY).not.toBe('auto');
  expect(geometry.paneOverflowY).toBe('auto');

  await page.mouse.move(geometry.wheelPoint.x, geometry.wheelPoint.y);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(content).toBeVisible();
});

test('appearance choice content stays vertically centered in stretched grid rows', async ({ window: page }) => {
  await page.evaluate(async () => {
    await window.maka.settings.update({ personalization: { uiLocale: 'en' } });
  });
  await page.reload();
  await page.waitForSelector(COMPOSER_INPUT);
  await page.setViewportSize({ width: 1650, height: 992 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'App icon' })).toBeVisible();

  for (const name of ['Azure', 'Classic']) {
    const card = page.getByRole('checkbox', { name, exact: true }).locator('..');
    await expect(card).toBeVisible();
    const geometry = await choiceContentGeometry(card);
    expect(geometry.cardHeight).toBeGreaterThan(geometry.contentHeight);
    expect(Math.abs(geometry.topGap - geometry.bottomGap)).toBeLessThanOrEqual(1);
  }
});

test('reopening settings keeps the last-ready General page stable while refreshing', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.locator('.settingsSurface');
  await page.getByRole('button', { name: '通用', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();
  await expect(settings.getByRole('button', { name: '默认模型' })).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置' })).toBeVisible();

  await page.evaluate(() => {
    const state = {
      sawLoadingWarning: false,
      sawGeneralWithoutReadyHostControls: false,
    };
    const inspect = () => {
      const surface = document.querySelector('.settingsSurface');
      const main = surface?.querySelector('main, [role="main"]');
      if (!surface || !main) return;
      state.sawLoadingWarning ||= Array.from(
        surface.querySelectorAll('[role="alert"]'),
      ).some((banner) => banner.textContent?.includes('正在加载设置') === true);
      const defaultModelReady = Array.from(main.querySelectorAll('*')).some(
        (element) =>
          element.children.length === 0 &&
          element.textContent?.trim() === '默认模型' &&
          Boolean(element.closest('.astryx-item')?.querySelector('button')),
      );
      state.sawGeneralWithoutReadyHostControls ||=
        main.querySelector('textarea') === null || !defaultModelReady;
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    Object.assign(window, {
      __makaSettingsReopenProbe: {
        finish() {
          inspect();
          observer.disconnect();
          return state;
        },
      },
    });
  });

  await page.getByRole('button', { name: '设置' }).click();
  await expect(settings.getByRole('textbox', { name: '助手语气偏好' })).toBeEnabled();
  await expect(settings.getByRole('button', { name: '默认模型' })).toBeEnabled();

  const probe = await page.evaluate(() => {
    const target = window as typeof window & {
      __makaSettingsReopenProbe: {
        finish(): {
          sawLoadingWarning: boolean;
          sawGeneralWithoutReadyHostControls: boolean;
        };
      };
    };
    return target.__makaSettingsReopenProbe.finish();
  });
  expect(probe.sawLoadingWarning).toBe(false);
  expect(probe.sawGeneralWithoutReadyHostControls).toBe(false);
});
