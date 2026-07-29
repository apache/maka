import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

/**
 * Both fixtures used here hand over a SETTLED sidebar state, which is what
 * makes the toggle read below sound: `window` boots collapsed from the
 * localStorage default and nothing moves it, and `sidebarLongSessionsWindow`
 * gates readiness on `[data-sidebar-state="expanded"]` — the state its
 * e2e-fixture applies asynchronously, several IPC round trips after the first
 * session rows render.
 *
 * Reading the toggle while that flip was still in flight is the
 * sidebar-navigation flake: the read saw "collapsed", and the click then
 * either never resolved (the label had become 收起侧边栏) or landed on the
 * already-expanded sidebar and collapsed it, after which every
 * `role=complementary` query missed — the collapsed panel is `aria-hidden`.
 */
async function expandedSidebar(page: Page) {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.count()) await expand.click();
  const sidebar = page.getByRole('complementary', { name: '对话列表' });
  await expect(sidebar).toBeVisible();
  return sidebar;
}

test('session grouping menu switches between flat conversations and project disclosures', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const grouping = sidebar.getByRole('button', { name: '会话分组方式' });
  const popup = page.locator('[data-slot="menu-popup"]');

  await expect(sidebar.locator('.maka-list-group-label')).toHaveCount(0);
  await expect(sidebar.locator('.maka-list-row').first()).toBeVisible();
  await grouping.click();
  const byTime = page.getByRole('menuitemradio', { name: '按时间' });
  const byProject = page.getByRole('menuitemradio', { name: '按项目' });
  await expect(byTime).toHaveAttribute('aria-checked', 'true');
  await byProject.click();
  await expect(sidebar.locator('.maka-list-project-heading').first()).toBeVisible();

  // A radio item does not dismiss the menu, so the single trigger click this
  // used to do was closing the menu, not reopening it — and the radios below
  // were read off a popup that was disappearing, which is why they sometimes
  // resolved and sometimes did not. Close and reopen explicitly, waiting for
  // the popup to actually leave in between: a trigger click landing while the
  // old popup is still on screen is swallowed as an outside-press.
  await grouping.click();
  await expect(popup).toBeHidden();
  await grouping.click();
  await expect(popup).toBeVisible();
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
