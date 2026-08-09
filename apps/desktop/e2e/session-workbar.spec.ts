import { test, expect } from './fixtures';

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
