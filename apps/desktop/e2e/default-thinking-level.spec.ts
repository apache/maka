import { expect, test, COMPOSER_INPUT } from './fixtures.js';

/**
 * Settings → 通用 → 默认思考级别 reaching the next new chat.
 *
 * This journey is e2e rather than unit because the bug it guards lives in the
 * seam between two async sources: the setting arrives from a settings fetch
 * that resolves AFTER the composer hook first mounts. Seeding it through a
 * useState initializer type-checks, renders, and persists correctly — and the
 * setting still never takes effect, because an initializer runs once, before
 * the value exists. Only a real round-trip through the settings page and back
 * catches that.
 */
test('a configured default thinking level reaches the next new chat, and the composer can still overrule it', async ({
  modelPickerLongWindow: page,
}) => {
  const composerChip = () =>
    page.locator('.maka-composer-left-controls').getByRole('button', { name: /思考级别/ });

  // Negative control: with nothing configured the chip is the model's own
  // default, so a later 关 cannot be mistaken for a value that was always there.
  await expect(composerChip()).toContainText('模型默认');

  await page.getByRole('button', { name: /设置|Settings/ }).click();
  await page
    .getByRole('navigation', { name: /设置分组|Settings sections/ })
    .getByRole('button', { name: /通用|General/, exact: true })
    .click();

  const selector = page.getByRole('combobox', { name: '默认思考级别' });
  await selector.scrollIntoViewIfNeeded();
  await expect(selector).toContainText('跟随模型默认');
  await selector.click();
  await page.getByRole('option', { name: '关', exact: true }).click();

  await expect
    .poll(() =>
      page.evaluate(() => window.maka.settings.get().then((value) => value.chatDefaults.thinkingLevel)),
    )
    .toBe('off');

  await page.getByRole('button', { name: /返回应用|Back to app/ }).click();
  // Scope to the composer before reading the chip: the settings Selector also
  // answers to /思考级别/ and reads 关 once set, so an unscoped lookup passes
  // whether or not the chip ever changed.
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(composerChip()).toHaveCount(1);
  await expect(composerChip()).toContainText('关');

  // The per-chat picker must still overrule the configured default — including
  // back to 模型默认, which is why an untouched picker and an explicit
  // 模型默认 pick cannot share one representation.
  await composerChip().click();
  await page.getByRole('menuitem', { name: '模型默认', exact: true }).click();
  await expect(composerChip()).toContainText('模型默认');
});
