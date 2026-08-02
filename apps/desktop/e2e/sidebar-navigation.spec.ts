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
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  await expect(sidebar).toBeVisible();
  return sidebar;
}

test('session grouping menu switches between flat conversations and project disclosures', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const grouping = sidebar.getByRole('button', { name: '会话分组方式' });
  const popup = page.getByRole('menu', { name: '会话分组方式' });

  await expect(sidebar.locator('[data-maka-contract="session-row"]').first()).toBeVisible();
  await grouping.click();
  const byTime = page.getByRole('menuitemradio', { name: '按时间' });
  const byProject = page.getByRole('menuitemradio', { name: '按项目' });
  await expect(byTime).toHaveAttribute('aria-checked', 'true');
  await byProject.click();
  await expect(sidebar.locator('[data-project-id]').first()).toBeVisible();
  await expect(sidebar.locator('.astryx-badge').first()).toBeVisible();

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

test('project mode nests sessions under collapsible project SideNav items', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  await sidebar.getByRole('button', { name: '会话分组方式' }).click();
  await page.getByRole('menuitemradio', { name: '按项目' }).click();

  const project = sidebar.locator('[data-project-id]').first();
  await expect(project).toBeVisible();
  // Project row is a collapsible SideNavItem (button with aria-expanded).
  const projectToggle = project.locator('button[aria-expanded]').first();
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  const session = project.locator('[data-maka-contract="session-row"]').first();
  await expect(session).toBeVisible();
  // Nested project sessions are ordinary nav rows, not subagent rows.
  await expect(session).not.toHaveAttribute('data-subagent', 'true');
  // Product zero-nest: session left edge matches the project row (no 24px tree indent).
  const projectBox = await projectToggle.boundingBox();
  const sessionBox = await session.boundingBox();
  expect(projectBox && sessionBox).toBeTruthy();
  if (projectBox && sessionBox) {
    expect(Math.abs(sessionBox.x - projectBox.x)).toBeLessThanOrEqual(2);
  }
});

test('project rename owns Enter without toggling the project disclosure', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  await sidebar.getByRole('button', { name: '会话分组方式' }).click();
  await page.getByRole('menuitemradio', { name: '按项目' }).click();

  const project = sidebar.locator('[data-project-id]').first();
  const projectToggle = project.locator('button[aria-expanded]').first();
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  await project.getByRole('button', { name: /项目操作$/ }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();

  const rename = project.getByRole('textbox', { name: '重命名' });
  await expect(rename).toBeFocused();
  const disclosureState = await projectToggle.getAttribute('aria-expanded');
  const originalName = await rename.inputValue();
  await rename.press('A');
  await expect(rename).toBeFocused();
  await rename.press('Space');
  await expect(rename).toHaveValue('A ');
  await expect(rename).toBeFocused();
  await rename.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      isComposing: true,
    }));
  });
  await expect(rename).toBeFocused();
  await rename.fill(originalName);
  await rename.press('Enter');
  await expect(projectToggle).toHaveAttribute('aria-expanded', disclosureState ?? 'false');
});

test('double-clicking the flat ListItem menu does not enter rename', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const row = sidebar.locator('[data-maka-contract="session-row"]').filter({ hasText: '会话 00' }).first();

  await row.getByRole('button', { name: '对话操作' }).dispatchEvent('dblclick');

  await expect(sidebar.getByRole('textbox', { name: '重命名对话' })).toHaveCount(0);
});

test('session delete intent opens only after its menu closes and restores the trigger', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const row = sidebar.locator('[data-maka-contract="session-row"]').filter({ hasText: '会话 00' }).first();
  // SideNavItem wraps the primary control: row > root div > button (not row > button).
  const rowButton = row.getByRole('button', { name: '会话 00' });
  await expect(rowButton).toHaveCount(1);
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

  await expect(sidebar.getByText('会话', { exact: true })).toHaveCount(1);
  await expect(sidebar.locator('[data-maka-contract="session-row"]').first()).toBeVisible();
});

test('scheduled-task hub restores the last selected child module', async ({ window: page }) => {
  const sidebar = await expandedSidebar(page);
  const scheduledTasks = sidebar.getByRole('button', { name: '定时任务', exact: true });
  await scheduledTasks.click();

  const selector = page.locator('.maka-module-hub-selector');
  await expect(selector).toHaveAccessibleName('定时任务内容：计划提醒');
  await selector.getByRole('button', { name: '每日回顾' }).click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await scheduledTasks.click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');
});
