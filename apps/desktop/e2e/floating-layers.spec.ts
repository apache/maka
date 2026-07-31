import { expect, test } from './fixtures.js';

/**
 * #1565 PR 5 — the floating kernel. Tooltip and Popover moved from Base UI
 * portals onto Astryx's native-Popover top layer (CSS anchor positioning, no
 * portal, no z-index). The static harnesses cannot see this: a closed
 * floating surface has no box, and the visual contract explicitly declares
 * top-layer content out of scope. These two journeys are the behavior
 * contract for the kernel every later slice (menus, dialogs, toasts)
 * builds on: the surface opens into the top layer, focus lands where the
 * consumer declared, Escape dismisses, and focus returns to the trigger.
 */

test('tooltip opens on hover in the top layer and dismisses on Escape', async ({
  window: page,
}) => {
  const trigger = page.getByRole('button', { name: '搜索对话' });
  await expect(trigger).toBeVisible();

  await trigger.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('搜索对话');

  // The surface must live in the browser top layer (`:popover-open`), not in
  // a portalled z-indexed container — that is the kernel's one structural
  // invariant, and what lets it paint above `maka.legacy` fixed chrome.
  await expect
    .poll(() => tooltip.evaluate((element) => element.closest('[popover]')?.matches(':popover-open') ?? false))
    .toBe(true);

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

  // Activating the trigger dismisses the tooltip (Base UI closeOnClick
  // parity): clicking a chrome button must not leave its hint floating under
  // the pointer. The one-shot check right after the click is what pins the
  // fix — every other hide path (hover bridge, focusout) is delayed by at
  // least 100ms, while the trigger's own dismissal is synchronous. The held
  // re-check catches a show still pending its 200ms delay popping in late.
  // The new-task button is the right subject: it resets only the main pane —
  // no modal to inert the tooltip out of the role tree (the search trigger)
  // and no chrome layout shift that could slide a neighboring trigger under
  // the stationary pointer (the sidebar toggle).
  const newTask = page.getByRole('button', { name: '新任务' });
  await newTask.hover();
  await expect(tooltip).toBeVisible();
  await newTask.click();
  expect(await tooltip.isHidden()).toBe(true);
  await page.waitForTimeout(350);
  await expect(tooltip).toBeHidden();
});

test('daily review uses the canonical time field and persists its value', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '每日回顾', exact: true }).click();

  const time = settings.getByRole('textbox', { name: '每日回顾执行时间' });
  await expect(time).toHaveValue('08:00');
  await time.fill('08:05');
  await time.blur();
  await expect(time).toHaveValue('08:05');

  await settings.getByRole('button', { name: '通用', exact: true }).click();
  await settings.getByRole('button', { name: '每日回顾', exact: true }).click();
  const persistedTime = settings.getByRole('textbox', {
    name: '每日回顾执行时间',
  });
  await expect(persistedTime).toHaveValue('08:05');

  await persistedTime.fill('24:00');
  await persistedTime.blur();
  await expect(persistedTime).toHaveAttribute('aria-invalid', 'true');
  await expect(
    settings.getByText('请输入 24 小时制时间，例如 08:00。'),
  ).toBeVisible();

  await settings.getByRole('button', { name: '通用', exact: true }).click();
  await settings.getByRole('button', { name: '每日回顾', exact: true }).click();
  await expect(
    settings.getByRole('textbox', { name: '每日回顾执行时间' }),
  ).toHaveValue('08:05');
});

test('model picker only exposes a rendered active descendant', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: /选择新对话模型/ }).click();

  const search = page.getByRole('combobox', { name: '搜索模型' });
  await expect(search).toBeFocused();

  await search.fill('no-such-model');
  await expect(page.getByText('没有匹配的模型')).toBeVisible();
  await expect(search).not.toHaveAttribute('aria-activedescendant');

  await search.fill('sonnet');
  const activeDescendant = await search.getAttribute('aria-activedescendant');
  expect(activeDescendant).not.toBeNull();
  await expect(page.locator(`#${activeDescendant}`)).toHaveRole('option');
});

test('model picker keeps keyboard highlight inside the scroll viewport', async ({
  modelPickerLongWindow: page,
}) => {
  await page.getByRole('button', { name: /选择新对话模型/ }).click();

  const search = page.getByRole('combobox', { name: '搜索模型' });
  const popup = page.locator('.modelPickerPopup');
  const listbox = page.getByRole('listbox', { name: /选择新对话模型/ });
  const options = listbox.getByRole('option');
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(8);
  await expect
    .poll(() => popup.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(420);
  await expect
    .poll(() =>
      listbox.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);

  for (let index = 0; index < optionCount; index += 1) {
    await search.press('ArrowDown');
  }

  const activeDescendant = await search.getAttribute('aria-activedescendant');
  expect(activeDescendant).not.toBeNull();
  const activeOption = page.locator(`[id="${activeDescendant}"]`);
  await expect(activeOption).toHaveAttribute('data-highlighted', '');
  await expect.poll(() => listbox.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(() =>
      activeOption.evaluate((element) => {
        const list = element.closest('[role="listbox"]');
        if (!list) return false;
        const optionRect = element.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return optionRect.top >= listRect.top - 0.5 && optionRect.bottom <= listRect.bottom + 0.5;
      }),
    )
    .toBe(true);
});

test('conditionally unmounted dialogs restore their opener by default', async ({
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
