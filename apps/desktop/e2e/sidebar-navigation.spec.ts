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
  const popup = page.getByRole('menu', { name: '会话分组方式' });

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
  await grouping.press('Enter');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: '按项目' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: '按时间' })).toHaveAttribute('aria-checked', 'false');
});

test('session grouping menu fits its Chinese labels instead of inheriting the generic minimum width', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  await sidebar.getByRole('button', { name: '会话分组方式' }).click();

  const popup = page.getByRole('menu', { name: '会话分组方式' });
  await expect(popup).toBeVisible();
  const width = await popup.evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeLessThan(128);
});

test('session delete intent opens only after its menu closes and restores the trigger', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const row = sidebar.locator('.maka-list-row').filter({ hasText: '会话 00' }).first();
  const rowButton = row.locator('[data-session-id]').first();
  await rowButton.focus();

  const trigger = row.getByRole('button', { name: '对话操作' });
  await trigger.press('Enter');
  const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: '删除', exact: true }) });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '删除', exact: true }).press('Enter');

  await expect(menu).toBeHidden();
  const confirm = page.getByRole('alertdialog', { name: '删除 "会话 00"' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(trigger).toBeFocused();
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

  const selector = page.locator('.maka-module-hub-selector');
  await expect(selector).toHaveAccessibleName('定时任务内容：计划提醒');
  await selector.getByRole('radio', { name: '每日回顾' }).click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await scheduledTasks.click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');
});
