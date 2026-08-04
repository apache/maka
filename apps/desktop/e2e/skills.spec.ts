// Skills page interaction hierarchy (#1901).
//
// These checks use the real Desktop bridge and seeded Skill inventory. They
// protect the visible contract rather than the component implementation: one
// direct invocation, one state control, and one menu for secondary actions.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

async function openInstalledSkills(page: Page) {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('main', { name: '扩展' }).waitFor();
  await page.getByRole('button', { name: '已安装' }).click();
}

test('keeps rare installed Skill actions in one contextual menu', async ({
  invocableSkillsWindow: page,
}) => {
  await openInstalledSkills(page);

  const row = page.locator('.maka-skill-library-list li').filter({ hasText: 'Workspace Only' });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button', { name: '在对话中使用 Workspace Only' })).toBeVisible();
  await expect(row.getByRole('switch')).toHaveCount(1);
  await expect(row.getByRole('button', { name: '打开 SKILL.md' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /删除/ })).toHaveCount(0);

  await row.getByRole('button', { name: 'Workspace Only 的更多操作' }).click();
  const menu = page.getByRole('menu', { name: 'Workspace Only 的更多操作' });
  await expect(menu.getByRole('menuitem', { name: '打开 SKILL.md' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '固定到技能上下文' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '删除', exact: true })).toBeVisible();
});
