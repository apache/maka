import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

async function enableMode(
  page: Page,
  mode: 'plan' | 'swarm',
  label: 'Plan' | 'Swarm',
): Promise<Locator> {
  await page.getByRole('button', { name: '模式' }).click();
  await page.getByRole('menuitemcheckbox', { name: label }).click();
  await page.keyboard.press('Escape');
  const indicator = page.locator(
    `.maka-composer-mode-indicator[data-mode="${mode}"]`,
  );
  await expect(indicator).toBeVisible();
  await expect(indicator.locator('svg.lucide-x')).toBeVisible();
  return indicator;
}

test('Plan and Swarm indicators remain visible and close directly', async ({
  window: page,
}) => {
  const firstSend = page.locator('.maka-composer-textarea');
  await firstSend.fill('open composer');
  await firstSend.press('Enter');
  await expect(page.getByText(/Fake backend received: open composer/)).toBeVisible();

  const permissionTrigger = page.locator('.maka-composer-header-context .permissionModeSelector');
  await expect(permissionTrigger).toBeVisible();

  for (const [mode, label] of [
    ['plan', 'Plan'],
    ['swarm', 'Swarm'],
  ] as const) {
    const indicator = await enableMode(page, mode, label);
    await indicator.click();
    await expect(indicator).toHaveCount(0);
  }
});
