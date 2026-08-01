import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function enableMode(
  page: Page,
  mode: 'plan' | 'swarm',
  label: 'Plan' | 'Swarm',
): Promise<Locator> {
  await page
    .locator('.maka-composer-plus-menu')
    .getByRole('button', { name: '添加上下文', exact: true })
    .click();
  // Plus menu: modes are single menuitemcheckbox rows (Astryx CheckboxItem).
  await page.getByRole('menuitemcheckbox', { name: label }).click();
  await page.keyboard.press('Escape');
  const indicator = page.locator(
    `.maka-composer-mode-indicator[data-mode="${mode}"]`,
  );
  await expect(indicator).toBeVisible();
  return indicator;
}

test('Plan and Swarm tokens remain visible and close from the drawer', async ({
  window: page,
}) => {
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('open composer');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: open composer/)).toBeVisible();

  // Permission is a ghost icon control in the left footer, not header context.
  const permissionTrigger = page
    .locator('.maka-composer-left-controls .permissionModeIcon')
    .getByRole('button');
  await expect(permissionTrigger).toBeVisible();

  for (const [mode, label] of [
    ['plan', 'Plan'],
    ['swarm', 'Swarm'],
  ] as const) {
    const indicator = await enableMode(page, mode, label);
    // Token remove control dismisses the active mode.
    await indicator.getByRole('button').click();
    await expect(indicator).toHaveCount(0);
  }
});
