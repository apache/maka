import { expect, test } from './fixtures.js';

// The seeded reminders carry distinct createdAt values so the default
// 创建时间倒序 sort has a single answer. Without them they tie in the same
// millisecond and the fallback comparator decides the order, which made any
// position-based assertion here flaky between runs. Rows are `li > button`
// now, not articles: per Astryx's List guidance an interactive list item
// carries no interactive children.
test('orders the seeded reminders deterministically under the default sort', async ({
  planRemindersWindow: page,
}) => {
  const rows = page.locator('.maka-module-page-rows > li');
  await expect(rows).toHaveCount(8);
  const expected = ['已触发的本地提醒', '每周竞品动态追踪', '暂停的发布检查', '同步项目风险'];
  for (const [index, title] of expected.entries()) {
    await expect(rows.nth(index)).toContainText(title);
  }
});

// Rows are inert selectors now: per Astryx's List guidance, interactive
// elements do not belong inside an interactive list item. Every action a row
// used to carry (switch, trigger, snooze, edit, duplicate, clear, delete) lives
// in the end-panel inspector, as a plain labelled button.
test('acts on a reminder through the inspector and keeps deletion reversible', async ({
  planRemindersWindow: page,
}) => {
  const pausedRow = page.getByRole('button', { name: /暂停的发布检查/ });
  await pausedRow.click();

  const deleteButton = page.getByRole('button', { name: '删除', exact: true });
  const enableSwitch = page.getByRole('switch', { name: '启用' });
  await expect(page.getByRole('button', { name: '立即触发' })).toBeVisible();
  await expect(deleteButton).toBeVisible();

  // The inspector is the only surface these actions have left, so one of them
  // has to prove the whole chain: row selection → inspector control → main
  // process → the row's own state. A paused reminder enables into 待触发.
  await expect(enableSwitch).not.toBeChecked();
  await enableSwitch.click();
  await expect(enableSwitch).toBeChecked();
  // The row carries its lifecycle state only on the StatusDot's accessible
  // name — a sibling of the row button, not inside it — and its description
  // picks up the schedule it just regained.
  const pausedItem = page
    .locator('.maka-module-page-rows > li')
    .filter({ hasText: '暂停的发布检查' });
  await expect(pausedItem.getByRole('img', { name: '待触发' })).toBeVisible();
  await expect(pausedRow).toHaveText(/下次触发/);

  await deleteButton.click();
  const deleteDialog = page.getByRole('alertdialog');
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).toBeHidden();
  await expect(pausedRow).toBeVisible();

  await deleteButton.click();
  await expect(deleteDialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(deleteDialog.getByRole('button', { name: '删除' })).toBeFocused();
  await page.keyboard.press('Enter');

  // The row is gone, and so is the inspector — nothing is selected any more.
  await expect(pausedRow).toHaveCount(0);
  await expect(page.getByRole('button', { name: '立即触发' })).toBeHidden();
  // The 删除 button went down with the inspector, so something has to catch
  // focus: without this the keyboard user lands on `body`, at the top of the
  // document, with the list scrolled wherever they left it.
  await expect(page.locator('.maka-module-page-rows > li button:focus')).toHaveCount(1);
});

// Inert rows put every action behind the inspector, and the inspector renders
// after the whole list. Without a roving tabindex, reaching it from row k of N
// costs N−k tab presses through rows that do nothing — the cheap part of the
// journey charged for the expensive one. One stop for the list is the contract.
test('reaches the inspector two tab stops from a row with rows after it', async ({
  planRemindersWindow: page,
}) => {
  const rows = page.locator('.maka-module-page-rows > li button');
  await expect(rows).toHaveCount(8);
  const inspector = page.getByRole('complementary', { name: '任务详情' });

  // The first row under 创建时间倒序, so seven rows follow it — seven presses
  // that reaching the inspector used to cost, one per row that does nothing.
  const firstRow = page.getByRole('button', { name: /已触发的本地提醒/ });
  const secondRow = page.getByRole('button', { name: /每周竞品动态追踪/ });
  const lastRow = page.getByRole('button', { name: /每日站会前汇总阻塞项/ });
  await firstRow.click();
  await expect(firstRow).toBeFocused();
  await expect(inspector).toBeVisible();

  // Stop 1: the inspector's own resize handle, a real keyboard control
  // (arrows resize the panel), so it keeps its place in the tab order.
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="separator"]:focus')).toHaveCount(1);
  // Stop 2: the inspector's first control. None of the seven rows below the
  // selected one was visited — the list holds one tab stop, not eight.
  await page.keyboard.press('Tab');
  await expect(inspector.locator(':focus')).toHaveCount(1);
  await expect(firstRow).toHaveAttribute('tabindex', '0');
  await expect(secondRow).toHaveAttribute('tabindex', '-1');
  await expect(lastRow).toHaveAttribute('tabindex', '-1');

  // Arrows are what the list gives back in exchange for its N−1 tab stops.
  await firstRow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(secondRow).toBeFocused();
  await page.keyboard.press('End');
  await expect(lastRow).toBeFocused();
  await page.keyboard.press('Home');
  await expect(firstRow).toBeFocused();

  // The stop has to MOVE with the arrows, not just be written once on mount:
  // the whole point of one tab stop is that Tab out and back returns you to
  // the row you were on, not to the row you started at.
  await page.keyboard.press('ArrowDown');
  await expect(secondRow).toHaveAttribute('tabindex', '0');
  await expect(firstRow).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Tab');
  await expect(page.locator('[role="separator"]:focus')).toHaveCount(1);
  await page.keyboard.press('Shift+Tab');
  await expect(secondRow).toBeFocused();
  // Arrows moved focus only: selection is the inspector's trigger, and firing
  // it on every arrow press would make browsing the list an action.
  await expect(inspector).toBeVisible();
  await expect(page.locator('.maka-module-page-rows > li[aria-current]')).toHaveCount(1);
  await expect(page.locator('.maka-module-page-rows > li').first()).toHaveAttribute('aria-current', 'true');
});

test('opens the edit dialog from the inspector and restores focus on Escape', async ({
  planRemindersWindow: page,
}) => {
  await page.getByRole('button', { name: /每周竞品动态追踪/ }).click();
  const editButton = page.getByRole('button', { name: '编辑', exact: true });
  await editButton.click();

  const dialog = page.getByRole('dialog', { name: '编辑定时任务' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '标题' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(editButton).toBeFocused();
});

test('narrow windows keep the inspector reachable and hand focus back', async ({
  planRemindersWindow: page,
}) => {
  const row = page.getByRole('button', { name: /每周竞品动态追踪/ });
  await row.click();

  // Crossing the breakpoint is not an action on this page: it must not open a
  // modal by itself, so the selection goes with the placement change.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // The side panel is gone at this width, but every action it carries is not.
  await row.click();
  const sheet = page.locator('dialog[open]');
  await expect(sheet).toHaveCount(1);
  await expect(sheet.getByRole('button', { name: '立即触发' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(row).toBeFocused();
});

// 480px is the app's own window floor (SAFE_MIN_WIDTH in window-state.ts), so
// this is a window a user really has. The page header is a flex row whose title
// column carries Astryx's `min-width: 0`: without a content floor the row keeps
// the actions at full width and squeezes the title instead, which at this width
// left 定时任务 running one glyph per line down 112px of header.
test('keeps the page title on one line at the window floor', async ({
  planRemindersWindow: page,
}) => {
  const title = page.locator('.maka-module-page h1');
  const oneLine = (await title.boundingBox())?.height ?? 0;
  expect(oneLine).toBeGreaterThan(0);

  for (const width of [640, 520, 480]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await title.boundingBox();
    expect(box, `title missing at ${width}px`).not.toBeNull();
    // One line, not four: allow a pixel of rounding, nothing near a wrap.
    expect(box?.height, `title wrapped at ${width}px`).toBeLessThanOrEqual(oneLine + 1);
  }
});

// The 900px clamp only means something against a real window: the Storybook
// page stories render without the app shell, so their column is content-sized
// and would satisfy any width assertion. This is the one place that runs the
// production geometry.
test('keeps the page column clamped on a wide window', async ({
  planRemindersWindow: page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const content = page.locator('.maka-module-page .astryx-layout-content').first();
  const box = await content.boundingBox();
  expect(box?.width, 'page column must stay clamped').toBeLessThanOrEqual(901);
});

// Astryx's Toolbar is a nowrap flex row, and the list controls carry fixed
// widths that together need 618px. Before they wrapped, the trailing ones
// simply left the page at narrow widths — past the plate's edge, unclickable,
// with no scroll to bring them back: the state filter was already gone at
// 640px, the sort control too by 480px.
test('keeps every list control inside the column at narrow widths', async ({
  planRemindersWindow: page,
}) => {
  const bar = page.locator('.maka-module-page-bar');
  const controls = bar.locator('input, .astryx-selector button');
  await expect(controls).not.toHaveCount(0);

  for (const width of [900, 640, 480]) {
    await page.setViewportSize({ width, height: 800 });
    const escaped = await bar.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll('input, .astryx-selector button')]
        .map((control) => control.getBoundingClientRect())
        .filter((r) => r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1))
        .map((r) => `${Math.round(r.left)}-${Math.round(r.right)}`);
    });
    expect(escaped, `control escaped the column at ${width}px`).toEqual([]);
  }
});
