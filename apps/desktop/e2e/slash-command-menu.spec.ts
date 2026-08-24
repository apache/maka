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
import { expect, test, COMPOSER_INPUT } from './fixtures';

test('shows only slash commands executable in the current session state', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.click();
  await composer.pressSequentially('/');

  const freshMenu = page.getByRole('listbox', { name: '命令和技能' });
  const freshCommands = freshMenu.getByRole('group', { name: '命令' });
  await expect(freshCommands.getByRole('option')).toHaveCount(2);
  await expect(freshCommands.getByRole('option', { name: /使用 Graph.*\/graph/ })).toBeVisible();
  await expect(freshCommands.getByRole('option', { name: /使用 Swarm.*\/swarm/ })).toBeVisible();

  await composer.press('Escape');
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: seed session')).toBeVisible();

  await composer.click();
  await composer.pressSequentially('/');

  const menu = page.getByRole('listbox', { name: '命令和技能' });
  const groups = menu.getByRole('group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute('aria-label', '命令');
  await expect(groups.nth(1)).toHaveAttribute('aria-label', 'Skills');

  await expect(groups.nth(0).getByRole('option')).toHaveCount(4);
});

test('compacts the active session', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: seed session')).toBeVisible();

  const sessionId = await page.evaluate(async () => (await window.maka.sessions.list())[0]?.id);
  expect(sessionId).toBeTruthy();
  await page.evaluate((activeSessionId) => {
    const testWindow = window as typeof window & {
      __makaObservedCompactCompletion?: boolean;
    };
    testWindow.__makaObservedCompactCompletion = false;
    window.maka.sessions.subscribeChanges((event) => {
      if (event.reason === 'status-change' && event.sessionId === activeSessionId) {
        testWindow.__makaObservedCompactCompletion = true;
      }
    });
  }, sessionId!);

  await composer.click();
  await composer.pressSequentially('/');

  const menu = page.getByRole('listbox', { name: '命令和技能' });
  const compact = menu.getByRole('group', { name: '命令' }).getByRole('option', {
    name: /压缩上下文.*\/compact/,
  });
  await compact.click();

  await expect.poll(() => composer.textContent()).toBe('/compact ');
  await expect(menu).not.toBeVisible();
  await composer.press('Enter');

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __makaObservedCompactCompletion?: boolean })
            .__makaObservedCompactCompletion,
      ),
    )
    .toBe(true);
  await expect.poll(() => composer.textContent()).toBe('');
  await expect(page.getByText('压缩失败')).toHaveCount(0);

  // After the compact completes the composer clears and can remount. `fill()`
  // can land before the contentEditable is focused again, so the draft never
  // populates and Enter submits nothing — the flake in issue #3289. Type
  // through the focused element and require the draft to have settled before
  // dispatching, mirroring the running-turn spec below.
  await composer.click();
  await composer.pressSequentially('after compact');
  await expect.poll(() => composer.textContent()).toBe('after compact');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: after compact')).toBeVisible();
  await expect(page.getByText('Fake backend received: /compact')).toHaveCount(0);
});

test('offers commands only for the first token and keeps explicit Skill queries separate', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: seed session')).toBeVisible();

  await composer.fill('explain /');
  const inlineMenu = page.getByRole('listbox', { name: '命令和技能' });
  await expect(inlineMenu.getByRole('group', { name: '命令' })).toHaveCount(0);
  await expect(inlineMenu.getByRole('group', { name: 'Skills' })).toBeVisible();

  await composer.fill('/skill:compact');
  await expect(inlineMenu.getByRole('option', { name: /\/compact/ })).toHaveCount(0);

  await composer.fill('/side');
  // macOS maps Home to document scrolling rather than line-start movement in
  // contentEditable. Put the caret at the same semantic position on every OS
  // before checking that a slash with text after the caret is not a command.
  await composer.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  await composer.press('ArrowRight');
  await expect(inlineMenu.getByRole('group', { name: '命令' })).toHaveCount(0);
});

test('dispatches /side instead of steering it into a running turn', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const runningPrompt = FAKE_HOLD_OPEN_PROMPT;
  await composer.fill(runningPrompt);
  await composer.press('Enter');
  await expect(page.locator('.maka-user-message', { hasText: runningPrompt })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible();

  await composer.click();
  await composer.pressSequentially('/');
  const menu = page.getByRole('listbox', { name: '命令和技能' });
  const commands = menu.getByRole('group', { name: '命令' });
  const side = commands.getByRole('option', { name: /打开侧聊.*\/side/ });
  await expect(side).toBeVisible();
  await expect(commands.getByRole('option', { name: /\/compact/ })).toHaveCount(0);
  await side.click();
  await expect.poll(() => composer.textContent()).toBe('/side ');
  await expect(page.locator('.maka-quote-workbar-panel')).toHaveCount(0);

  await composer.fill('/side discuss separately');
  await composer.press('Enter');

  await expect(page.locator('.maka-quote-workbar-panel')).toHaveCount(1);
  await page.getByRole('button', { name: '停止' }).click();
});
