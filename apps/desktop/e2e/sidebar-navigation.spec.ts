import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

async function expandedSidebar(page: Page) {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.count()) await expand.click();
  return page.getByRole('complementary', { name: '对话列表' });
}

test('session grouping menu switches between flat conversations and project disclosures', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const grouping = sidebar.getByRole('button', { name: '会话分组方式' });

  await expect(sidebar.locator('.maka-list-group-label')).toHaveCount(0);
  await expect(sidebar.locator('.maka-list-row').first()).toBeVisible();
  await grouping.click();
  const byTime = page.getByRole('menuitemradio', { name: '按时间' });
  const byProject = page.getByRole('menuitemradio', { name: '按项目' });
  await expect(byTime).toHaveAttribute('aria-checked', 'true');
  await byProject.click();
  await expect(sidebar.locator('.maka-list-project-heading').first()).toBeVisible();

  await grouping.click();
  await expect(page.getByRole('menuitemradio', { name: '按项目' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: '按时间' })).toHaveAttribute('aria-checked', 'false');
});

test('session grouping menu fits its Chinese labels instead of inheriting the generic minimum width', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  await sidebar.getByRole('button', { name: '会话分组方式' }).click();

  const popup = page.locator('[data-slot="menu-popup"]');
  await expect(popup).toBeVisible();
  const width = await popup.evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThan(128);
});

test('session heading stays singular and the default list has no redundant heading', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const panelHeading = sidebar.locator('.maka-session-list-heading');
  const navLabel = sidebar.locator('.maka-nav-row span:nth-child(2)').first();

  await expect(sidebar.getByText('会话', { exact: true })).toHaveCount(1);
  await expect(sidebar.locator('.maka-list-group-label')).toHaveCount(0);

  const fontSizes = await Promise.all(
    [navLabel, panelHeading].map((locator) =>
      locator.evaluate((element) => getComputedStyle(element).fontSize),
    ),
  );
  expect(fontSizes).toEqual(['13px', '13px']);
});

test('scheduled-task hub restores the last selected child module', async ({ window: page }) => {
  const sidebar = await expandedSidebar(page);
  const scheduledTasks = sidebar.getByRole('button', { name: '定时任务', exact: true });
  await scheduledTasks.click();

  const selector = page.locator('.maka-module-hub-selector-trigger');
  await expect(selector).toHaveAccessibleName('定时任务内容：计划提醒');
  await selector.click();
  await page.getByRole('menuitemradio', { name: '每日回顾' }).click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await scheduledTasks.click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');
});
