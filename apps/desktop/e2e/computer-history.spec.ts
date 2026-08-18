import { COMPOSER_INPUT, expect, test } from './fixtures';

test('Computer History opens as a workbar tool and adds reduced context to chat', async ({
  computerHistoryWindow: page,
}, testInfo) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create history session');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create history session/)).toBeVisible();

  await page.getByRole('button', { name: '展开任务工作栏' }).click();
  await page.getByRole('button', { name: /电脑历史.*查看本机应用活动/ }).click();
  const panel = page.locator('.computerHistoryPanel');
  await expect(panel.getByText('Notes · Launch checklist')).toBeVisible();
  await expect(panel.getByText('Browser · Release dashboard')).toBeVisible();
  await expect(panel.getByText('输入文本采集关闭；只保留应用、窗口和交互类型。')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('computer-history-desktop.png'),
    fullPage: true,
  });

  await panel.getByRole('button', { name: '加入对话' }).first().click();
  await expect(composer).toContainText('<computer-history-context');
  await expect(composer).not.toContainText('secret');

  await page.setViewportSize({ width: 375, height: 780 });
  await expect(panel).toBeVisible();
  const overflow = await panel.evaluate(
    (node) => node.scrollWidth > node.clientWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('computer-history-375.png'),
    fullPage: true,
  });
});
