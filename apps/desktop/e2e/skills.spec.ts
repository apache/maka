// Skills page interaction hierarchy.
//
// These checks use the real Desktop bridge and seeded Skill inventory. They
// protect the visible contract rather than the component implementation:
// installed rows are selectable and otherwise inert, and every per-skill
// action lives in the end-panel inspector — the same surface as 定时任务.

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

async function openInstalledSkills(page: Page) {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await page.getByRole('main', { name: '扩展' }).waitFor();
  await page.getByRole('radio', { name: '已安装' }).click();
}

test('keeps installed rows inert and routes every per-skill action through the inspector', async ({
  invocableSkillsWindow: page,
}) => {
  await openInstalledSkills(page);

  // The row itself is the one click target — a button named by the skill.
  const row = page.getByRole('button', { name: /Workspace Only/ });
  await expect(row).toBeVisible();
  // Nothing else rides the row: no switch, no overflow menu, no use button.
  const item = page.getByRole('listitem').filter({ hasText: 'Workspace Only' });
  await expect(item.getByRole('switch')).toHaveCount(0);
  await expect(item.getByRole('button', { name: /更多操作/ })).toHaveCount(0);

  await row.click();
  const inspector = page.getByRole('complementary', { name: '技能详情' });
  await expect(inspector.getByRole('switch', { name: '启用' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '使用', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '打开 SKILL.md' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '固定到技能上下文' })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '删除', exact: true })).toBeVisible();
});
