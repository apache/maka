import { COMPOSER_INPUT, expect, test } from './fixtures';

test('an explicit new task survives a renderer reload without reopening history', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create history');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create history/)).toBeVisible();

  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await expect(page.locator('.maka-composer-workspace-dock')).toBeVisible();
  await composer.fill('draft survives renderer replacement');

  await page.reload();

  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('draft survives renderer replacement');
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await expect(page.locator('.maka-composer-workspace-dock')).toBeVisible();
});

test('a renderer reload during first send adopts the newly persisted Session', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('existing history');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: existing history/)).toBeVisible();

  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await composer.fill('first send across reload');
  await composer.press('Enter');
  await page.reload();

  await expect(page.getByText(/Fake backend received: first send across reload/)).toBeVisible();
  await expect(page.getByText(/Fake backend received: existing history/)).toHaveCount(0);
});
