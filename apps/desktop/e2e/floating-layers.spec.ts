import { expect, test, COMPOSER_INPUT } from './fixtures.js';

test('model and adjacent thinking menus persist one real Electron journey', async ({
  modelPickerLongWindow: page,
}) => {
  const thinkingTrigger = page.getByRole('button', { name: /思考级别/ });
  await thinkingTrigger.click();
  await page.getByRole('menuitem', { name: '关', exact: true }).click();
  await expect(thinkingTrigger).toContainText('关');

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('model selector persistence journey');
  await composer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: model selector persistence journey/),
  ).toBeVisible();

  const activeThinkingTrigger = page.getByRole('button', { name: /思考级别/ });
  await expect(activeThinkingTrigger).toContainText('关');
  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.getByRole('button', { name: /思考级别/ })).toContainText('关');

  const modelTrigger = page.getByRole('button', { name: '切换当前会话模型' });
  await modelTrigger.click();
  await page.getByRole('menuitem', { name: 'claude-e2e-1', exact: true }).click();
  await expect(page.getByText('已切换当前会话模型')).toBeVisible();
  await expect(modelTrigger).toContainText('claude-e2e-1');
});

test('search closes before navigating and focusing the matched turn', async ({
  window: page,
}) => {
  const needle = 'search ownership needle 7319';
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(needle);
  await composer.press('Enter');
  await expect(page.getByText(`Fake backend received: ${needle}`)).toBeVisible();

  const opener = page.getByRole('button', { name: '搜索对话' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '搜索' });
  const input = dialog.getByRole('combobox', { name: '搜索会话' });
  await input.fill(needle);
  const result = dialog.getByRole('option', { name: /用户消息/ });
  await expect(result).toBeVisible();
  await result.click();

  await expect(dialog).toBeHidden();
  const target = page.locator('.maka-turn').filter({ hasText: needle });
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('data-search-highlight', 'true');
  await expect(opener).not.toBeFocused();
});
