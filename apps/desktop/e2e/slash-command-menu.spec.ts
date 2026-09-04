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

test('does not open the slash menu for path separators', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const menu = page.getByRole('listbox', { name: '命令和技能' });

  for (const prefix of ['帮我整理到/Users', 'path/to/file']) {
    await composer.fill(prefix);
    await composer.evaluate((editable) => {
      // Chromium can put the next typed character in a new text node. Recreate
      // that observed input shape without letting Playwright normalize the DOM.
      const node = editable.appendChild(document.createTextNode('/'));
      const range = document.createRange();
      range.setStart(node, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      editable.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: '/',
        inputType: 'insertText',
      }));
    });

    await expect(menu).toHaveCount(0);
    await expect.poll(() => composer.textContent()).toBe(`${prefix}/`);
    await expect
      .poll(() =>
        composer.evaluate((editable) => {
          const selection = window.getSelection();
          if (!selection?.focusNode || !editable.contains(selection.focusNode)) return -1;
          const range = document.createRange();
          range.selectNodeContents(editable);
          range.setEnd(selection.focusNode, selection.focusOffset);
          return range.toString().length;
        }),
      )
      .toBe(`${prefix}/`.length);
  }
});

test('opens the slash menu after a DOM block break', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const menu = page.getByRole('listbox', { name: '命令和技能' });

  await composer.fill('first line');
  await composer.evaluate((editable) => {
    const block = document.createElement('div');
    const slash = block.appendChild(document.createTextNode('/'));
    editable.appendChild(block);

    const range = document.createRange();
    range.setStart(slash, 1);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    editable.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: '/',
      inputType: 'insertText',
    }));
  });

  await expect.poll(() => composer.evaluate((editable) => editable.innerText)).toBe(
    'first line\n/',
  );
  await expect(menu).toBeVisible();
});

test('an open menu keeps its container and skills group across projection refreshes', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('seed session');
  await composer.press('Enter');
  await expect(page.getByText('Fake backend received: seed session')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);

  // The completed turn publishes its own projection refresh. Wait on the
  // composer's public loading state so that work cannot spill into the window
  // this test is about.
  await page.getByRole('button', { name: '添加上下文' }).click();
  const contextMenu = page.getByRole('menu', { name: '添加上下文' });
  await expect(contextMenu.getByRole('menuitem', { name: /选择技能/ })).not.toHaveAttribute(
    'aria-busy',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(contextMenu).toHaveCount(0);

  await composer.click();
  await composer.pressSequentially('/');
  const menu = page.getByRole('listbox', { name: '命令和技能' });
  await expect(menu.getByRole('group', { name: 'Skills' })).toBeVisible();

  // A thinking-level change publishes the session's 'updated' event and
  // reloads the Skill projection without changing what the menu shows: the
  // exact same-content refresh that used to alternate the popup (#2667).
  const observation = await menu.evaluate(async (menuElement) => {
    const sessions = await (
      window as unknown as {
        maka: { sessions: { list(): Promise<Array<{ id: string }>> } };
      }
    ).maka.sessions.list();
    const sessionId = sessions[0]?.id;
    if (!sessionId) throw new Error('Session missing before projection refresh');

    // Arm immediately before the refreshes and only on this popover. The
    // document body also contains unrelated overlays whose teardown says
    // nothing about this menu's identity.
    const menuContainer = menuElement.parentElement;
    const state = { menuRemovals: 0, skillsGroupRemovals: 0 };
    const skillsGroup = menuElement.querySelector<HTMLElement>('[role="group"][aria-label="Skills"]');
    if (!menuContainer) throw new Error('Slash menu container missing before projection refresh');
    if (!skillsGroup) throw new Error('Skills group missing before projection refresh');
    const recordRemoval = (
      mutations: MutationRecord[],
      watchedNode: Node,
      key: 'menuRemovals' | 'skillsGroupRemovals',
    ) => {
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node === watchedNode) state[key] += 1;
        }
      }
    };
    const menuObserver = new MutationObserver((mutations) => {
      recordRemoval(mutations, menuElement, 'menuRemovals');
    });
    const skillsGroupObserver = new MutationObserver((mutations) => {
      recordRemoval(mutations, skillsGroup, 'skillsGroupRemovals');
    });
    menuObserver.observe(menuContainer, { childList: true });
    skillsGroupObserver.observe(menuElement, { childList: true });
    const maka = (
      window as unknown as {
        maka: {
          sessions: {
            setThinkingLevel(id: string, level?: null): Promise<unknown>;
          };
        };
      }
    ).maka;
    const e2eControls = (
      window as unknown as {
        makaE2eLatch?: {
          waitForInvocableSkillsCall(sessionId: string): Promise<void>;
        };
      }
    ).makaE2eLatch;
    if (!e2eControls) throw new Error('E2E bridge controls missing before projection refresh');
    try {
      for (let round = 0; round < 3; round += 1) {
        const projectionSettled = e2eControls.waitForInvocableSkillsCall(sessionId);
        await maka.sessions.setThinkingLevel(sessionId, null);
        await projectionSettled;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      }
    } finally {
      // Drain the final queued batch before closing the exact refresh window;
      // polling a monotonic counter cannot turn a failure into success.
      recordRemoval(menuObserver.takeRecords(), menuElement, 'menuRemovals');
      recordRemoval(skillsGroupObserver.takeRecords(), skillsGroup, 'skillsGroupRemovals');
      menuObserver.disconnect();
      skillsGroupObserver.disconnect();
    }
    return {
      ...state,
      menuConnected: menuElement.isConnected,
      skillsGroupConnected: skillsGroup.isConnected,
    };
  });
  expect(observation).toEqual({
    menuRemovals: 0,
    skillsGroupRemovals: 0,
    menuConnected: true,
    skillsGroupConnected: true,
  });
  await expect(menu.getByRole('group', { name: 'Skills' })).toBeVisible();
});
