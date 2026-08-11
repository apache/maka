import { COMPOSER_INPUT, test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function openGitChanges(page: Page) {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create review session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create review session/)).toBeVisible();
  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(page.getByRole('list', { name: '打开工具' })).toBeVisible();
  await page.getByRole('button', { name: /变更.*查看当前 Git 工作区变化/ }).click();
  return page.getByRole('region', { name: 'Git 变更' });
}

test('titlebar workbar action restores an existing tool instead of the picker', async ({
  gitReviewWindow,
}) => {
  const page = gitReviewWindow.page;
  const workspaceActions = page.getByRole('toolbar', { name: '工作区辅助操作' });
  const panel = await openGitChanges(page);
  await expect(workspaceActions.getByRole('button', { name: '收起会话工作栏' })).toBeVisible();
  await expect(workspaceActions.getByRole('button', { name: '打开工作栏工具' })).toHaveCount(0);
  await page.getByRole('button', { name: '打开工作栏标签' }).click();
  const picker = page.getByRole('list', { name: '打开工具' });
  await expect(picker).toBeVisible();

  await workspaceActions.getByRole('button', { name: '收起会话工作栏' }).click();
  await workspaceActions.getByRole('button', { name: '展开会话工作栏' }).click();

  await expect(panel).toBeVisible();
  await expect(picker).not.toBeVisible();
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
