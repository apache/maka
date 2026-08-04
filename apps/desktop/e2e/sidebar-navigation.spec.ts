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

test('session grouping switch flips between flat conversations and project disclosures', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const grouping = sidebar.getByRole('radiogroup', { name: '会话分组方式' });
  const byTime = grouping.getByRole('radio', { name: '按时间' });
  const byProject = grouping.getByRole('radio', { name: '按项目' });

  await expect(sidebar.locator('[data-maka-contract="session-row"]').first()).toBeVisible();

  // The point of an inline switch over the old dropdown: the current grouping
  // is readable without opening anything, before and after the change.
  await expect(byTime).toHaveAttribute('aria-checked', 'true');
  await expect(byProject).toBeVisible();

  await byProject.click();
  await expect(sidebar.locator('[data-project-id]').first()).toBeVisible();
  await expect(sidebar.locator('.astryx-badge').first()).toBeVisible();
  await expect(byProject).toHaveAttribute('aria-checked', 'true');
  await expect(byTime).toHaveAttribute('aria-checked', 'false');
});

test('project mode nests sessions under collapsible project SideNav items', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  await sidebar.getByRole('radio', { name: '按项目' }).click();

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
  await sidebar.getByRole('radio', { name: '按项目' }).click();

  // Anchor on the SEEDED project (see LONG_SIDEBAR_PROJECT_* in
  // seed-helpers): `.first()` used to race the app's async workspace
  // self-registration — when only the 未归属项目 pseudo-group existed, its
  // row has no 项目操作 trigger and the click below waited out its timeout.
  const project = sidebar
    .locator('[data-project-id]')
    .filter({ hasText: '示例项目' })
    .first();
  const projectToggle = project.locator('button[aria-expanded]').first();
  await expect(project).toBeVisible();
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  // Capture the disclosure state while the disclosure control is mounted:
  // starting a rename swaps the whole project row for the rename input, so
  // `button[aria-expanded]` does not exist while editing (SideNavItem rows
  // replace the row, unlike the pre-#1860 TreeList that kept it mounted).
  const disclosureState = await projectToggle.getAttribute('aria-expanded');
  // SideNavItem renders `endContent` inside the row's primary <button>, so
  // the row button's accessible name is its composite contents and ends with
  // the actions trigger's label — a plain name query matches both (strict
  // mode violation). The trigger is the only button inside the project's own
  // end content, so scope the name query there. (The nesting is Astryx
  // SideNavItem's own DOM — SideNavItem also drops extra props in expanded
  // mode, so the parent's name cannot be overridden — and pulling the
  // trigger out of the item button would need sidebar.css, frozen by
  // in-review PR #1857.)
  const projectActions = project
    .locator('.maka-project-item-end')
    .getByRole('button', { name: /项目操作$/ });
  // focus + Enter, the suite's menu-trigger idiom (plan-reminders.spec's
  // openFocusedMenu): the trigger nests inside the row's composite
  // SideNavItem button, and pointer hit-testing on that nesting is
  // CI-timing sensitive; keyboard activation exercises the same menu.
  await projectActions.focus();
  await expect(projectActions).toBeFocused();
  await page.keyboard.press('Enter');
  const renameItem = page.getByRole('menuitem', { name: '重命名', exact: true });
  await expect(renameItem).toBeVisible();
  await renameItem.click();

  // Sidebar-scoped: starting a rename swaps the row's content for the input,
  // so the name-filtered `project` locator cannot match while editing (the
  // name lives in the input's value, which hasText does not read).
  const rename = sidebar.getByRole('textbox', { name: '重命名' });
  await expect(rename).toBeFocused();
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

  // exact: SideNavItem computes the row button's name from its contents, so
  // a substring name query matches both the row button and this trigger.
  await row.getByRole('button', { name: '对话操作', exact: true }).dispatchEvent('dblclick');

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

  // Same composite-name ambiguity as the project row above: match the
  // trigger's own name exactly, not the row button's computed name.
  const trigger = row.getByRole('button', { name: '对话操作', exact: true });
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
  await expect(page.getByRole('radiogroup', { name: '时间范围切换' })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成分析' })).toBeVisible();
  await expect(page.getByText('模型使用', { exact: true })).toHaveCount(0);
  await expect(page.getByText('工具调用', { exact: true })).toHaveCount(0);

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await scheduledTasks.click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');
});
