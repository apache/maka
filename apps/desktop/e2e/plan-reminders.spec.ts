import { expect, test } from './fixtures.js';

test('keeps Plan row actions keyboard ordered and destructive confirmation reversible', async ({
  planRemindersWindow: page,
}) => {
  const pausedRow = page.getByRole('article').filter({ hasText: '暂停的发布检查' });
  const pausedSwitch = pausedRow.getByRole('switch', { name: '启用提醒: 暂停的发布检查' });
  const pausedMenu = pausedRow.getByRole('button', { name: '提醒操作: 暂停的发布检查' });
  const editItem = page.getByRole('menuitem', { name: '编辑' });
  const deleteItem = page.getByRole('menuitem', { name: '删除' });
  const openFocusedMenu = async (): Promise<void> => {
    await page.keyboard.press('Enter');
    await expect(editItem).toBeVisible();
    await expect(editItem).toBeFocused();
  };

  await pausedMenu.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(pausedSwitch).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pausedMenu).toBeFocused();
  const focusStyle = await pausedMenu.evaluate((element) => {
    const style = getComputedStyle(element);
    return { boxShadow: style.boxShadow, outlineStyle: style.outlineStyle };
  });
  expect(
    focusStyle.boxShadow !== 'none' || focusStyle.outlineStyle !== 'none',
    'keyboard focus must remain visibly indicated',
  ).toBe(true);

  await openFocusedMenu();
  await page.keyboard.press('End');
  await expect(deleteItem).toBeFocused();
  await page.keyboard.press('Enter');

  const deleteDialog = page.getByRole('alertdialog');
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).toBeHidden();
  await expect(pausedRow).toBeVisible();
  await expect(pausedMenu).toBeFocused();

  await openFocusedMenu();
  await page.keyboard.press('End');
  await expect(deleteItem).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(deleteDialog.getByRole('button', { name: '删除' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pausedRow).toHaveCount(0);

  const reviewRow = page.getByRole('article').filter({ hasText: '每周竞品动态追踪' });
  const reviewMenu = reviewRow.getByRole('button', { name: '提醒操作: 每周竞品动态追踪' });
  const clearItem = page.getByRole('menuitem', { name: '清空记录' });
  await reviewMenu.focus();
  await openFocusedMenu();
  await page.keyboard.press('End');
  await expect(deleteItem).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(clearItem).toBeFocused();
  await page.keyboard.press('Enter');

  const clearDialog = page.getByRole('alertdialog');
  await expect(clearDialog).toBeVisible();
  await expect(clearDialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(clearDialog).toBeHidden();
  // Premium-row redesign: run MESSAGES live in the 执行记录 tab; the task row
  // keeps its schedule line. Cancelling the clear must leave the row intact.
  await expect(reviewRow).toContainText('每周竞品动态追踪');
  await expect(reviewMenu).toBeFocused();
});

test('closes a reminder menu before opening its edit dialog', async ({
  planRemindersWindow: page,
}) => {
  const row = page.getByRole('article').filter({ hasText: '暂停的发布检查' });
  const menu = row.getByRole('button', { name: '提醒操作: 暂停的发布检查' });
  await menu.click();
  await page.getByRole('menuitem', { name: '编辑' }).click();

  await expect(page.getByRole('menu')).toBeHidden();
  const dialog = page.getByRole('dialog', { name: '编辑提醒' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '标题' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(menu).toBeFocused();
});
