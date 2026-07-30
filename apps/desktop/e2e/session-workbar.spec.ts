import { test, expect } from './fixtures';

test('session tools share one user-controlled workbar', async ({ sessionWorkbarWindow: page }) => {
  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  const tabs = workbar.getByRole('tablist', { name: '会话工作栏栏目' });

  await expect(tabs.getByRole('tab', { name: /任务/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: /浏览器/ })).toBeDisabled();
  await expect(tabs.getByRole('tab', { name: /文件/ })).toBeEnabled();
  await expect(workbar.getByText('完成会话任务台账升级')).toBeVisible();

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(workbar).toBeHidden();

  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(workbar).toBeVisible();
  await tabs.getByRole('tab', { name: /文件/ }).click();
  await expect(workbar.getByText('暂无生成文件')).toBeVisible();

  await page.setViewportSize({ width: 480, height: 320 });
  const narrowLayout = await workbar.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    viewportHeight: window.innerHeight,
  }));
  expect(narrowLayout.height).toBeLessThanOrEqual(narrowLayout.viewportHeight * 0.42 + 1);

  await page.locator('button[aria-label="展开侧边栏"]').dispatchEvent('click');
  await page.locator('button[aria-label="扩展"]').dispatchEvent('click');
  await expect(workbar).toBeHidden();
  await expect(page.getByRole('main', { name: '扩展' })).toBeVisible();
});

test('workbar toggle stays unmounted without an active session', async ({ window: page }) => {
  // The overflow trigger also carries aria-expanded (its menu opens/closes),
  // so pin the workbar toggle by its label instead of the shared attribute.
  const toggle = page
    .getByRole('toolbar', { name: '工作区辅助操作' })
    .getByRole('button', { name: /会话工作栏/ });

  await expect(toggle).toHaveCount(0);
});
