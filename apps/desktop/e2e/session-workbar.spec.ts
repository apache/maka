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

test('Git changes show branch files as a collapsed single-open list', async ({
  gitReviewWindow,
}) => {
  const panel = await openGitChanges(gitReviewWindow.page);
  const feature = panel.getByRole('button', { name: /feature\.txt/ });
  const base = panel.getByRole('button', { name: /base\.txt/ });
  await expect(feature).toHaveAttribute('aria-expanded', 'false');
  await expect(base).toHaveAttribute('aria-expanded', 'false');

  await feature.click();
  await expect(feature).toHaveAttribute('aria-expanded', 'true');
  await base.click();
  await expect(base).toHaveAttribute('aria-expanded', 'true');
  await expect(feature).toHaveAttribute('aria-expanded', 'false');
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

test('generated files use list-to-preview navigation with a compact action menu', async ({ artifactPaneWindow: page }) => {
  const pane = page.getByRole('region', { name: '生成文件预览面板' });
  const list = pane.getByRole('listbox', { name: '生成文件列表' });
  const notes = list.getByRole('option', { name: 'notes.md' });

  await expect(list).toBeVisible();
  await notes.click();

  await expect(list).toHaveCount(0);
  await expect(pane.getByRole('region', { name: '预览 notes.md' })).toBeVisible();
  await expect(pane.getByRole('button', { name: '返回生成文件列表' })).toBeVisible();

  await pane.getByRole('button', { name: 'notes.md 的更多操作' }).click();
  await expect(page.getByRole('menuitem', { name: '在 Finder 中打开' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '另存为' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible();
  await page.keyboard.press('Escape');

  await pane.getByRole('button', { name: '返回生成文件列表' }).click();
  await expect(list).toBeVisible();
  await expect(list).toBeFocused();

  await list.press('Enter');
  await expect(list).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(list).toBeVisible();
  await expect(list).toBeFocused();
});

// Workbar product journey. Narrow max-height and "toggle unmounted without a
// session" are pinned in chat-shell-layout-contract (CSS + chrome actions source).
