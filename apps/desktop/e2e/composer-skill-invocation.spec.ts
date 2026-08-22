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

test('staged Skills come back as chips after leaving and returning', async ({
  invocableSkillsWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  const projectChip = page.locator('[data-astryx-token-value="/skill:project-only"]');
  const workspaceChip = page.locator('[data-astryx-token-value="/skill:workspace-only"]');
  const pick = async (query: string, name: RegExp) => {
    await composer.click();
    await composer.pressSequentially(` /${query}`);
    const option = page.getByRole('listbox', { name: /技能/ }).getByRole('option', { name });
    await expect(option).toBeVisible();
    // This journey owns draft restoration, while keyboard selection is covered
    // separately. Select the exact option without coupling setup to the
    // popover's transient highlighted-item state under concurrent workers.
    await option.click();
  };

  await composer.fill('alpha-marker');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: alpha-marker/)).toBeVisible();

  await pick('project', /Project Only/);
  await composer.pressSequentially('run it');
  await pick('workspace', /Workspace Only/);
  await expect(projectChip).toContainText('Project Only');
  // Both chips must land before navigating away: leaving while the second
  // token is still committing races the draft snapshot and loses the chip.
  await expect(workspaceChip).toContainText('Workspace Only');

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(composer).toHaveText('');

  await sidebar.locator('[data-session-id]').first().click();
  await expect(composer).toContainText('run it');
  await expect(projectChip).toContainText('Project Only');
  await expect(workspaceChip).toContainText('Workspace Only');
  // The token text itself is gone: a chip drawn beside the text it renders
  // would mean the draft now carried the Skill twice.
  await expect(composer).not.toContainText('/skill:');

  await composer.click();
  await composer.press('Enter');
  await expect(
    page.getByLabel('你发送的消息').last().locator('.astryx-badge'),
  ).toHaveText(['Project Only', 'Workspace Only']);
});

// The starter-skill window, three phases in dependency order: the blocked
// invocation pins zero turns and zero sessions so it must run before any
// send; the chip-only send then re-enables the Skill and owns the first
// message; the ＋ entry phases send nothing and run last.
