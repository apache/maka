import { COMPOSER_INPUT, expect, test } from './fixtures';

test('an explicit new task survives a renderer reload without reopening history', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('create history');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: create history/)).toBeVisible();

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await expect(page.locator('.maka-composer-workspace-dock')).toBeVisible();

  await page.reload();

  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.locator('.maka-turn')).toHaveCount(0);
  await expect(page.locator('.maka-composer-workspace-dock')).toBeVisible();
});
