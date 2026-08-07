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
  // Product zero-nest: session left edge matches the project row (no 24px tree indent).
  const projectBox = await projectToggle.boundingBox();
  const sessionBox = await session.boundingBox();
  expect(projectBox && sessionBox).toBeTruthy();
  if (projectBox && sessionBox) {
    expect(Math.abs(sessionBox.x - projectBox.x)).toBeLessThanOrEqual(2);
  }
});

/**
 * Renaming a project goes through a dialog, and the row it names keeps its
 * place — including its disclosure state.
 *
 * The in-place field this replaced had to defend that itself: it sat inside the
 * project row, so Enter bubbled to the SideNavItem and collapsed the group, and
 * an IME's composing Enter had to be told apart from a committing one. Neither
 * is reachable from a dialog, which is most of why it is one.
 */
test('renaming a project commits from the dialog and leaves its disclosure alone', async ({
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
  // SideNavItem renders `endContent` inside the row's primary <button>, so
  // the row button's accessible name is its composite contents and ends with
  // the actions trigger's label — a plain name query matches both (strict
  // mode violation). The trigger is the only button inside the project's own
  // end content, so scope the name query there.
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

  const dialog = page.getByRole('dialog', { name: '重命名项目' });
  const rename = dialog.getByRole('textbox');
  await expect(rename).toBeFocused();
  // Seeded from the row it was opened on, so a rename starts as an edit of the
  // current name rather than an empty field.
  await expect(rename).toHaveValue('示例项目');
  await rename.fill('示例项目 II');
  await rename.press('Enter');

  await expect(dialog).toBeHidden();
  await expect(
    sidebar.locator('[data-project-id]').filter({ hasText: '示例项目 II' }).first(),
  ).toBeVisible();
  await expect(projectToggle).toHaveAttribute('aria-expanded', 'true');
  // The project row captures its opener through its own ref and query, which
  // is a different few lines from the session row's — the shared half is only
  // the hand-back itself.
  await expect(projectActions).toBeFocused();
});

test('double-clicking the flat ListItem menu does not enter rename', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = await expandedSidebar(page);
  const row = sidebar.locator('[data-maka-contract="session-row"]').filter({ hasText: '会话 00' }).first();

  // exact: SideNavItem computes the row button's name from its contents, so
  // a substring name query matches both the row button and this trigger.
  await row.getByRole('button', { name: '对话操作', exact: true }).dispatchEvent('dblclick');

  await expect(page.getByRole('dialog')).toHaveCount(0);
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

/**
 * A rename replaces the name, not the row — the same invariant the titlebar's
 * breadcrumb holds one column to the right, reached the other way.
 *
 * In the titlebar the name is the open session's own heading, and the crumb is
 * a standalone element built to be swapped. Here it is one property of a list
 * item, and the item is an Astryx `SideNavItem`: `label` is a `string`, the
 * whole row is one `<button>`, and a text field may not live inside a button.
 * Editing in place therefore meant standing in for the row — and the stand-in
 * had to re-derive its box (it came out 31px against 32, re-weighting the text
 * under the cursor and stepping every row below it up a pixel), its leading
 * icon, its trailing column, and its subtree, which is not decoration but every
 * descendant row: renaming a session with running subagents took the whole
 * branch off screen.
 *
 * A dialog leaves all of that alone by construction, which is what this rests
 * on — the fixture seeds no parent/child pair, so the measurements below cover
 * the row and its neighbour, not a subtree. What they do pin is the part that
 * regressed twice: the row keeps its box, and nothing under it moves.
 */
test('renaming a session leaves its row exactly where it was', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  const row = sidebar.locator('[data-maka-contract="session-row"]').first();
  const read = () =>
    page.evaluate(() => {
      const first = document.querySelector('[data-maka-contract="session-row"]') as HTMLElement;
      const box = (el: Element | null) =>
        el
          ? {
              x: Math.round(el.getBoundingClientRect().x),
              width: Math.round(el.getBoundingClientRect().width),
            }
          : null;
      const inner = first.querySelector('.astryx-side-nav-item') as HTMLElement;
      const next = document.querySelectorAll('[data-maka-contract="session-row"]')[1] as
        | HTMLElement
        | undefined;
      const style = getComputedStyle(inner);
      return {
        rowHeight: Math.round(first.getBoundingClientRect().height),
        // Null rather than a throw: the shift is what this measures, so an
        // absent neighbour should read as a changed measurement, not a crash
        // inside the page.
        nextRowY: next ? Math.round(next.getBoundingClientRect().y) : null,
        // `'absent'` rather than null: these two are Astryx's own DOM, and a
        // markup change that made both reads null would leave the comparison
        // passing on two nulls while measuring nothing. A sentinel still
        // compares equal to itself, but it says so in the failure text of
        // whichever OTHER measurement moves.
        name: box(first.querySelector('.astryx-side-nav-item > span')) ?? 'absent',
        trailing: box(first.querySelector('.maka-session-row-trailing')) ?? 'absent',
        type: `${style.fontSize}/${style.fontWeight}`,
      };
    });

  const before = await read();
  const trigger = row.locator('.maka-session-row-end').getByRole('button').first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名对话' });
  await expect(dialog.getByRole('textbox')).toBeFocused();

  expect(await read()).toEqual(before);

  // Escape leaves, and hands the keyboard back where it came from — the same
  // contract the delete confirm one item below in this menu already keeps.
  // Closing by unmounting the dialog skips Astryx's focus restore and drops
  // the user on <body>, with the next Tab starting at the top of the window.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

/**
 * The session branch of the rename actually commits.
 *
 * The project branch is covered above, and the titlebar's rename reaches
 * storage through a different component entirely — so `commitRename`'s
 * session arm was the one path with no test on it, and a swapped ternary
 * there would rename nothing while every other rename test stayed green.
 */
test('renaming a session from the dialog reaches the row', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const sidebar = page.getByRole('navigation', { name: '对话列表' });
  const row = sidebar
    .locator('[data-maka-contract="session-row"]')
    .filter({ hasText: '会话 00' })
    .first();
  await row.locator('.maka-session-row-end').getByRole('button').first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '重命名对话' });
  const field = dialog.getByRole('textbox');
  await expect(field).toHaveValue('会话 00');
  await field.fill('会话 零零');
  await field.press('Enter');

  await expect(dialog).toBeHidden();
  await expect(
    sidebar.locator('[data-maka-contract="session-row"]').filter({ hasText: '会话 零零' }),
  ).toHaveCount(1);
});
