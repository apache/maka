import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

async function expectPaletteHeaderGeometry(dialog: Locator): Promise<void> {
  const searchInput = dialog.getByRole('combobox', { name: '搜索命令、设置项或会话' });
  const closeButton = dialog.getByRole('button', { name: '关闭命令面板' });
  const firstCommand = dialog.getByRole('option').first();
  const [inputBox, closeBox, firstCommandBox, paddingLeft, leadingSearchIcons] = await Promise.all([
    searchInput.boundingBox(),
    closeButton.boundingBox(),
    firstCommand.boundingBox(),
    searchInput.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft)),
    dialog.locator('.maka-palette-search-icon svg').count(),
  ]);
  if (!inputBox || !closeBox || !firstCommandBox) throw new Error('Command palette controls must have rendered bounds');

  const gap = closeBox.x - (inputBox.x + inputBox.width);
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(paddingLeft).toBeGreaterThanOrEqual(8);
  expect(leadingSearchIcons).toBe(1);
  expect(firstCommandBox.height).toBeGreaterThanOrEqual(32);
}

async function expectCompactShortcutHints(dialog: Locator): Promise<void> {
  const keys = dialog.locator('.maka-palette-footer kbd');
  await expect(keys).toHaveCount(4);
  for (const key of await keys.all()) {
    const style = await key.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        borderWidth: computed.borderWidth,
        boxShadow: computed.boxShadow,
      };
    });
    expect(style.height).toBe(16);
    expect(style.borderWidth).toBe('0px');
    expect(style.boxShadow).toBe('none');
  }
}

test('command palette header geometry and dismissal stay intact', async ({ window: page }) => {
  const dialog = page.getByRole('dialog', { name: '命令面板' });

  // The palette entry now lives behind the workspace topbar overflow menu
  // (see topbar-overflow.spec.ts); open it via trigger → menuitem.
  const openPalette = async (): Promise<void> => {
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '打开命令面板' }).click();
  };

  await openPalette();
  await expect(dialog).toBeVisible();
  await expectPaletteHeaderGeometry(dialog);
  await expectCompactShortcutHints(dialog);

  await page.setViewportSize({ width: 520, height: 700 });
  await expect(dialog).toBeVisible();
  await expectPaletteHeaderGeometry(dialog);

  await dialog.getByRole('button', { name: '关闭命令面板' }).click();
  await expect(dialog).toBeHidden();

  await openPalette();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('new plan reminder command opens the existing form and applies a template', async ({ window: page }) => {
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '打开命令面板' }).click();

  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('combobox', { name: '搜索命令、设置项或会话' }).fill('新建计划提醒');
  await palette.getByRole('option', { name: /新建计划提醒/ }).click();

  const reminderDialog = page.getByRole('dialog', { name: '新建提醒' });
  await expect(reminderDialog).toBeVisible();
  const title = reminderDialog.getByRole('textbox', { name: '标题' });
  await expect(title).toBeFocused();

  await reminderDialog.getByRole('button', { name: '使用模板' }).click();
  await page.getByRole('menuitem', { name: /每日新闻摘要.*每天 09:30/ }).click();

  await expect(title).toHaveValue('每日新闻摘要');
  await expect(reminderDialog.getByRole('textbox', { name: '备注' })).toHaveValue(/科技 \/ AI \/ Maka/);
  await expect(reminderDialog.getByRole('textbox', { name: 'Cron' })).toHaveValue('30 9 * * *');
  await expect(reminderDialog.getByRole('textbox', { name: '提醒时间' })).toHaveValue(/09:30$/);
});
