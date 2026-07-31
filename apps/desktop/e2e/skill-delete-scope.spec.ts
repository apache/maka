// User-scope skill deletion E2E (#1517).
//
// The delete path is the one place the Skills panel removes files from the
// user's HOME rather than from app-managed workspace data, so the journey that
// matters is the whole round trip: the button is offered for the scopes the
// backend can actually delete, two clicks remove the directory from disk, and
// the row is gone on the refresh that follows.
//
// This spec only exists because `buildE2eEnv` now sandboxes HOME. Before that,
// running it would have deleted a real skill out of the developer's
// `~/.agents/skills`. The unit tests in `skills.test.ts` cover the containment
// guards against a temp filesystem; what they cannot cover is the renderer
// sending a scope-aware ref through IPC and the list agreeing afterwards.

import { access } from 'node:fs/promises';
import path from 'node:path';
import { e2eHomeDir, test, expect } from './fixtures.js';

test('deletes a user-scope skill from disk and drops it from the list', async ({
  invocableSkillsWindow: page,
}) => {
  const skillDir = path.join(e2eHomeDir(), '.agents', 'skills', 'user-only');
  // The sandbox is real: the seeded skill is on disk before anything happens.
  await access(skillDir);

  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('complementary', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('main', { name: '扩展' }).waitFor();

  // The panel always renders all three tabs, and it picks its landing tab from
  // whatever the skill list happened to be at mount — so click 已安装
  // unconditionally and let Playwright wait for it. Sampling `isVisible()`
  // first only added a branch that could skip the click on a slow mount and
  // then hunt for the row on the wrong tab.
  await page.getByRole('tab', { name: '已安装' }).click();

  const row = page.locator('.maka-skill-library-list li').filter({ hasText: 'User Only' });
  await expect(row).toHaveCount(1);

  // Two-step confirm: the first click only arms the button, so the skill must
  // still be on disk at this point — a single stray click cannot delete.
  const deleteButton = row.getByRole('button', { name: /删除/ });
  await deleteButton.click();
  await access(skillDir);

  await deleteButton.click();

  await expect(row).toHaveCount(0);
  await expect.poll(() => access(skillDir).then(() => 'present', () => 'gone')).toBe('gone');
});

test('offers no delete for a project-scope skill', async ({ invocableSkillsWindow: page }) => {
  // Project skills live in the user's repo and are left to git — the backend
  // refuses them with `blocked_scope`, and the panel must not offer a button
  // that cannot work.
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('complementary', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('main', { name: '扩展' }).waitFor();

  await page.getByRole('tab', { name: '已安装' }).click();

  const projectRow = page.locator('.maka-skill-library-list li').filter({ hasText: 'Project Only' });
  await expect(projectRow).toHaveCount(1);
  await expect(projectRow.getByRole('button', { name: /删除/ })).toHaveCount(0);
});
