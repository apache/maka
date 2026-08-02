import { test, expect } from './fixtures';

// Workbar product journey. Narrow max-height and "toggle unmounted without a
// session" are pinned in chat-shell-layout-contract (CSS + chrome actions source).
test('session tools share one user-controlled workbar', async ({ sessionWorkbarWindow: page }) => {
  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  const tabs = workbar.getByRole('navigation', { name: '会话工作栏栏目' });

  await expect(tabs.getByRole('button', { name: /任务/ })).toHaveAttribute('aria-current', 'page');
  await expect(tabs.getByRole('button', { name: /浏览器/ })).toHaveCount(0);
  await expect(tabs.getByRole('button', { name: /文件/ })).toBeEnabled();
  await expect(
    workbar.getByRole('tree', { name: '活跃会话任务' }).getByText('完成会话任务台账升级'),
  ).toBeVisible();

  // Keyboard-driven disclosure, observed through what the user can read: a
  // collapsed section hides its rows, and Enter on the trigger reveals them.
  const recent = workbar.getByRole('button', { name: /最近结束/ });
  const recentRow = workbar.getByText('验证 Goal 一次提醒门禁');
  await expect(recent).toHaveAttribute('aria-expanded', 'false');
  await expect(recentRow).toBeHidden();

  await recent.focus();
  await recent.press('Enter');
  await expect(recent).toHaveAttribute('aria-expanded', 'true');
  await expect(recentRow).toBeVisible();

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(workbar).toBeHidden();

  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(workbar).toBeVisible();
  await tabs.getByRole('button', { name: /文件/ }).click();
  await expect(workbar.getByText('暂无生成文件')).toBeVisible();

  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page
    .getByRole('navigation', { name: '对话列表' })
    .getByRole('button', { name: '扩展', exact: true })
    .dispatchEvent('click');
  await expect(workbar).toBeHidden();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
});
