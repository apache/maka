import { expect, test, COMPOSER_INPUT } from './fixtures.js';

/**
 * #1565 PR 5 — Astryx owns Tooltip and Popover behavior. These journeys lock
 * the public user contract: surfaces open, dismiss, and restore focus without
 * Maka inspecting Astryx's native layer implementation.
 */

test('tooltip opens on hover and dismisses on Escape', async ({
  window: page,
}) => {
  const trigger = page.getByRole('button', { name: '搜索对话' });
  await expect(trigger).toBeVisible();

  await trigger.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('搜索对话');

  // WCAG 1.4.13: hover content must be dismissible without moving the pointer,
  // and an Escape-dismissed tooltip must not reappear until the pointer leaves
  // and re-enters. Wait past the 200ms Astryx show delay before concluding —
  // an immediate assertion would pass vacuously while a re-show is pending.
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.waitForTimeout(350);
  await expect(tooltip).toBeHidden();

  // And it must not linger once the pointer leaves.
  await page.mouse.move(10, 300);
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(10, 300);
  await expect(tooltip).toBeHidden();
});

test('daily review uses the canonical time field and persists its value', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settingsNavigation = page.getByRole('navigation', { name: '设置分组' });
  const settings = page.getByRole('main', { name: '设置内容' });
  await settingsNavigation.getByRole('button', { name: '每日回顾', exact: true }).click();

  const time = settings.getByRole('textbox', { name: '执行时间' });
  await expect(time).toHaveValue('08:00');
  await time.fill('08:05');
  await time.blur();
  await expect(time).toHaveValue('08:05');

  await settingsNavigation.getByRole('button', { name: '通用', exact: true }).click();
  await settingsNavigation.getByRole('button', { name: '每日回顾', exact: true }).click();
  const persistedTime = settings.getByRole('textbox', {
    name: '执行时间',
  });
  await expect(persistedTime).toHaveValue('08:05');

  await persistedTime.fill('24:00');
  await persistedTime.blur();
  await expect(persistedTime).toHaveAttribute('aria-invalid', 'true');
  await expect(
    settings.getByText('请输入 24 小时制时间，例如 08:00。'),
  ).toBeVisible();

  await settingsNavigation.getByRole('button', { name: '通用', exact: true }).click();
  await settingsNavigation.getByRole('button', { name: '每日回顾', exact: true }).click();
  await expect(
    settings.getByRole('textbox', { name: '执行时间' }),
  ).toHaveValue('08:05');
});

test('model picker only exposes a rendered active descendant', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: /选择新对话模型/ }).click();

  const search = page.getByPlaceholder('搜索模型');
  await expect(search).toBeFocused();

  await search.fill('no-such-model');
  await expect(page.getByRole('listbox').getByText('No results found')).toBeVisible();
  await expect(search).not.toHaveAttribute('aria-activedescendant');

  await search.fill('sonnet');
  await search.press('ArrowDown');
  const activeDescendant = await search.getAttribute('aria-activedescendant');
  expect(activeDescendant).not.toBeNull();
  await expect(page.locator(`#${activeDescendant}`)).toHaveRole('option');
});

// Model-picker mark geometry / label ellipsis: CSS contract
// (chat-shell-layout-contract). Listbox scroll-into-view is Astryx-owned.
// Keep focus restore + real session model/thinking persistence below.

test('model Selector restores focus to its opener on Escape', async ({
  window: page,
}) => {
  const trigger = page.getByRole('button', { name: /选择新对话模型/ });
  await trigger.click();

  const search = page.getByPlaceholder('搜索模型');
  const listbox = page.getByRole('listbox');
  const popup = listbox.locator('xpath=ancestor::*[@popover][1]');
  await expect(search).toBeFocused();
  await expect(listbox.getByRole('option').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('model and adjacent thinking Selectors persist one real Electron journey', async ({
  modelPickerLongWindow: page,
}) => {
  const thinkingTrigger = page.getByRole('combobox', { name: '思考级别' });
  await thinkingTrigger.click();
  await page.getByRole('option', { name: '关', exact: true }).click();
  await expect(thinkingTrigger).toContainText('关');

  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('model selector persistence journey');
  await composer.press('Enter');
  await expect(
    page.getByText(/Fake backend received: model selector persistence journey/),
  ).toBeVisible();

  const activeThinkingTrigger = page.getByRole('combobox', { name: '思考级别' });
  await expect(activeThinkingTrigger).toContainText('关');
  await page.reload();
  await expect(page.locator(COMPOSER_INPUT)).toBeVisible();
  await expect(page.getByRole('combobox', { name: '思考级别' })).toContainText('关');

  const modelTrigger = page.getByRole('button', { name: '切换当前会话模型' });
  await modelTrigger.click();
  const search = page.getByPlaceholder('搜索模型');
  await search.fill('claude-e2e-1');
  await page.getByRole('option', { name: 'claude-e2e-1', exact: true }).click();
  await expect(page.getByText('已切换当前会话模型')).toBeVisible();
  await expect(modelTrigger).toContainText('claude-e2e-1');
});

test('keyboard help lets Astryx restore its opener on close', async ({
  window: page,
}) => {
  const opener = page.getByRole('button', { name: '搜索对话' });
  await opener.focus();
  await page.keyboard.press('Control+/');

  const dialog = page.getByRole('dialog', { name: '键盘快捷键' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('a title-only search result restores focus to the opener', async ({
  sidebarLongSessionsWindow: page,
}) => {
  const opener = page.getByRole('button', { name: '搜索对话' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '搜索' });
  await dialog
    .getByRole('combobox', { name: '搜索会话' })
    .fill('会话 01');
  await dialog.getByRole('option', { name: /会话 01/ }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('示例对话 01')).toBeVisible();
  await expect(opener).toBeFocused();
});

test('search dialog lets Astryx restore its opener on ordinary close', async ({
  window: page,
}) => {
  const opener = page.getByRole('button', { name: '搜索对话' });
  await opener.click();

  const dialog = page.getByRole('dialog', { name: '搜索' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
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
