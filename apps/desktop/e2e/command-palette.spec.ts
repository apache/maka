import { expect, test } from './fixtures';

test('command palette follows the Astryx keyboard journey and dismisses', async ({
  window: page,
}) => {
  const trigger = page.getByRole('button', { name: '更多操作' });
  const dialog = page.getByRole('dialog', { name: '命令面板' });
  const openPalette = async (): Promise<void> => {
    await trigger.click();
    await page.getByRole('menuitem', { name: '打开命令面板' }).click();
    await expect(
      dialog.getByRole('combobox', { name: '命令面板搜索' }),
    ).toBeFocused();
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
  await input.fill('打开设置');
  const settingsOption = dialog.getByRole('option', {
    name: /^打开设置/,
  });
  await expect(settingsOption).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const activeDescendant = await input.getAttribute('aria-activedescendant');
  expect(activeDescendant).not.toBeNull();
  await expect(page.locator(`#${activeDescendant}`)).toHaveRole('option');
  await expect(page.locator(`#${activeDescendant}`)).toHaveAccessibleName(
    /^打开设置/,
  );

  await page.keyboard.press('Enter');
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('main', { name: '设置内容' })).toBeHidden();
  await openPalette();
  await page.setViewportSize({ width: 520, height: 700 });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
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
  await expect(palette).toBeHidden();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
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

  const reminderTime = reminderDialog.getByRole('textbox', {
    name: '提醒时间',
  });
  await reminderTime.fill('not-a-time');
  await expect(reminderTime).toHaveAttribute('aria-invalid', 'true');
  await expect(reminderDialog.getByText('选择有效的提醒时间。')).toBeVisible();
  await expect(
    reminderDialog.getByRole('button', { name: '创建提醒' }),
  ).toBeDisabled();

  await reminderTime.fill('2000-01-01T00:00');
  await expect(reminderTime).toHaveAttribute('aria-invalid', 'true');
  await expect(
    reminderDialog.getByText('提醒时间必须晚于当前时间。'),
  ).toBeVisible();

  await reminderDialog.getByRole('button', { name: '1 小时后' }).click();
  await expect(
    reminderDialog.getByText('提醒时间必须晚于当前时间。'),
  ).toBeHidden();
  const createReminder = reminderDialog.getByRole('button', { name: '创建提醒' });
  await expect(createReminder).toBeEnabled();
  await createReminder.click();
  await expect(reminderDialog).toBeHidden();

  const reminder = await page.evaluate(async () => {
    const reminders = await window.maka.plans.list();
    return reminders.find((entry) => entry.title === '每日新闻摘要');
  });
  expect(reminder).toMatchObject({
    title: '每日新闻摘要',
    schedule: {
      kind: 'cron',
      expression: '30 9 * * *',
    },
    delivery: { channel: 'local' },
    enabled: true,
  });
});
