import { test, expect } from './fixtures';

// Locks the structure promised by #1433 (desired outcome 3): the workspace
// topbar collapses its secondary actions behind a single overflow menu
// instead of rendering them as persistent icon buttons. The workbar toggle
// stays direct (it is a layout control, symmetric with the sidebar toggle).
//
// Uses the sessionWorkbarWindow fixture so the workbar toggle is mounted —
// the resident-button count is then exactly two (overflow trigger + workbar).
test('workspace topbar folds secondary actions into an overflow menu', async ({ sessionWorkbarWindow: page }) => {
  const toolbar = page.getByRole('toolbar', { name: '工作区辅助操作' });
  await expect(toolbar).toBeVisible();

  // Structural boundary: exactly two resident buttons (overflow + workbar).
  // A future direct button added here fails before the inset geometry
  // contract ever notices — that contract only checks count↔inset math.
  await expect(toolbar.getByRole('button')).toHaveCount(2);

  // The four secondary actions are not direct toolbar buttons.
  for (const name of ['问题反馈', '打开命令面板', '打开帮助', '打开健康中心']) {
    await expect(toolbar.getByRole('button', { name })).toHaveCount(0);
  }

  const overflow = toolbar.getByRole('button', { name: '更多操作' });
  await expect(overflow).toBeVisible();

  // Each secondary action surfaces only behind the overflow menu, and clicking
  // a menuitem fires its callback (the destination opens) — not just visible.
  const openSecondary = async (label: string): Promise<void> => {
    await overflow.click();
    await page.getByRole('menuitem', { name: label }).click();
  };

  // feedback → opens Settings (About section).
  await openSecondary('问题反馈');
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.keyboard.press('Escape');

  // help → opens the keyboard-shortcut dialog.
  await openSecondary('打开帮助');
  await expect(page.locator('.maka-help-modal')).toBeVisible();
  await page.keyboard.press('Escape');

  // health → opens Settings (Health section).
  await openSecondary('打开健康中心');
  await expect(page.getByRole('main', { name: '设置内容' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The command-palette entry is end-to-end verified by command-palette.spec
  // (overflow → menuitem → dialog); here we only assert it is present.
  await overflow.click();
  await expect(page.getByRole('menuitem', { name: '打开命令面板' })).toBeVisible();
});
