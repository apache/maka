import { expect, test } from './fixtures';

test('command palette follows the Astryx keyboard journey and dismisses', async ({
  window: page,
}) => {
  const dialog = page.getByRole('dialog', { name: '命令面板' });
  const openPalette = async (): Promise<void> => {
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '打开命令面板' }).click();
  };

  await openPalette();
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('combobox', {
    name: '命令面板搜索',
  });
  await expect(
    dialog.getByRole('listbox', { name: '命令面板结果' }),
  ).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('设置');
  await expect(dialog.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/);

  await page.setViewportSize({ width: 520, height: 700 });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('new plan reminder command opens the existing form and applies a template', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '打开命令面板' }).click();

  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette
    .getByRole('combobox', { name: '命令面板搜索' })
    .fill('新建计划提醒');
  await palette.getByRole('option', { name: /新建计划提醒/ }).click();

  const reminderDialog = page.getByRole('dialog', { name: '新建提醒' });
  await expect(reminderDialog).toBeVisible();
  const title = reminderDialog.getByRole('textbox', { name: '标题' });
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-required', 'true');
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await title.fill('临时标题');
  await expect(
    reminderDialog.getByRole('textbox', { name: '提醒时间' }),
  ).toHaveAttribute('aria-required', 'true');

  await reminderDialog.getByRole('button', { name: '使用模板' }).click();
  await page
    .getByRole('menuitem', { name: /每日新闻摘要.*每天 09:30/ })
    .click();

  await expect(title).toHaveValue('每日新闻摘要');
  await expect(
    reminderDialog.getByRole('textbox', { name: '备注' }),
  ).toHaveValue(/科技 \/ AI \/ Maka/);
  await expect(reminderDialog.getByRole('textbox', { name: 'Cron' })).toHaveValue(
    '30 9 * * *',
  );
  await expect(
    reminderDialog.getByRole('textbox', { name: '提醒时间' }),
  ).toHaveValue(/09:30$/);
});
