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

import type { Page } from '@playwright/test';
import { expect, test, COMPOSER_INPUT } from './fixtures';

/**
 * Revision drafts, per session, with a Skill staged in them.
 *
 * A staged Skill is a `/skill:<id>` chip inside the draft text, so every path
 * here — begin edit, prepare the branch, fail the send, cancel back — moves it
 * by moving the text. The point of these journeys is that nothing has to carry
 * the Skill separately for that to hold.
 *
 * The Skill itself comes from the real catalog (the invocable-skills fixture
 * plus the Skills module page), not a Desktop-only starter IPC.
 */
async function openInstalledWorkspaceSkill(page: Page): Promise<void> {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '任务列表' });
  await sidebar.getByRole('button', { name: '扩展' }).click();
  await expect(page.locator('[data-module="skills"]')).toBeVisible();
  await expect(page.getByText('Workspace Only', { exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
}

async function seedEditableTurn(page: Page): Promise<void> {
  const firstSend = page.locator(COMPOSER_INPUT);
  await firstSend.fill('original message');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: original message/)).toBeVisible();
}

/** Type the draft, then append the Skill chip — the order a user works in. */
async function composeWithSkill(page: Page, text: string, name: RegExp): Promise<void> {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(text);
  await composer.click();
  await composer.pressSequentially(' /');
  const option = page.getByRole('listbox', { name: /技能/ }).getByRole('option', { name });
  await expect(option).toBeVisible();
  await option.click();
}

async function beginRevision(page: Page): Promise<void> {
  const userMessage = page.getByLabel('你发送的消息').first();
  await userMessage.hover();
  await userMessage.getByRole('button', { name: '编辑并重发' }).click();
  await expect(page.locator('[data-revision-notice="true"]')).toBeVisible();
}

async function failWorkspaceSkillRevision(page: Page): Promise<void> {
  const disabled = await page.evaluate(() =>
    window.maka.skills.setEnabled('workspace-only', false),
  );
  expect(disabled.ok).toBe(true);

  const composer = page.locator(COMPOSER_INPUT);
  await composer.press('Enter');
  await expect(page.getByText('Skill 调用失败，消息未发送')).toBeVisible();
  // The draft survives the rejection whole, and reads as the token rather than
  // as a chip: the Skill was just disabled, so it is gone from the catalog the
  // composer draws chips from. A chip here would promise a Skill that no longer
  // resolves — the text is the honest rendering, and re-enabling it below sends.
  await expect(composer).toContainText('edited with skill');
  await expect(composer).toContainText('/skill:workspace-only');
}

test('a successful revision retry clears both child and source drafts', async ({
  invocableSkillsWindow: page,
}) => {
  await openInstalledWorkspaceSkill(page);
  await seedEditableTurn(page);
  await beginRevision(page);
  await composeWithSkill(page, 'edited with skill', /Workspace Only/);
  await failWorkspaceSkillRevision(page);

  const enabled = await page.evaluate(() =>
    window.maka.skills.setEnabled('workspace-only', true),
  );
  expect(enabled.ok).toBe(true);
  await page.locator(COMPOSER_INPUT).press('Enter');

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await page.getByRole('button', { name: '查看上一版本' }).click();
  await expect(
    page.getByLabel('你发送的消息').getByText('original message', { exact: true }),
  ).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
});

test('cancelling a failed revision restores the complete pre-edit draft', async ({
  invocableSkillsWindow: page,
}) => {
  await openInstalledWorkspaceSkill(page);
  await seedEditableTurn(page);

  const composer = page.locator(COMPOSER_INPUT);
  await composeWithSkill(page, 'previous unsent draft', /Project Only/);
  await beginRevision(page);
  await composeWithSkill(page, 'edited with skill', /Workspace Only/);
  await failWorkspaceSkillRevision(page);

  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.locator('[data-revision-notice="true"]')).toHaveCount(0);
  // Restored through a single controlled write, which rebuilds the editor from
  // the serialized draft; the Skill comes back as a chip because the composer
  // redraws it from that text, not because anything carried it separately.
  await expect(composer).toContainText('previous unsent draft');
  await expect(
    page.locator('[data-astryx-token-value="/skill:project-only"]'),
  ).toContainText('Project Only');
});
