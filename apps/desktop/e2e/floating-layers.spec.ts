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

test('time-picker popover owns focus placement and every dismiss path', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '每日回顾', exact: true }).click();

  const trigger = settings.getByRole('button', { name: '每日回顾执行时间' });
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '每日回顾执行时间' });
  await expect(dialog).toBeVisible();

  // Initial focus lands on the *selected* hour (08 from the default 08:00),
  // not the first row — the `initialFocus` contract the old Base UI popup
  // honored and the Astryx-backed PopoverPopup must keep honoring.
  const selectedHour = dialog.getByRole('listbox', { name: '时' }).getByRole('option', { name: '08' });
  await expect(selectedHour).toBeFocused();

  // Picking a minute updates the value, which re-renders the picker while
  // the popover is open. Initial focus is a once-per-open action: it must
  // NOT re-fire on that re-render and yank focus back to the hour column.
  const minute = dialog.getByRole('listbox', { name: '分' }).getByRole('option', { name: '30' });
  await minute.click();
  await expect(minute).toBeFocused();
  await page.waitForTimeout(150);
  await expect(minute).toBeFocused();

  // Clicking the open trigger closes the popover — native light dismiss
  // fires during the press (on pointerup per the HTML spec) and the same
  // gesture's trailing click must not re-open it. Hold the assertion past
  // the race window.
  await trigger.click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(150);
  await expect(dialog).toBeHidden();

  // Clicking outside light-dismisses and the trigger ring turns off.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await settings.getByRole('button', { name: '每日回顾', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).not.toHaveAttribute('data-popup-open');

  // Escape closes the popover and hands focus back to the trigger. No
  // settling wait before this click: a fast re-open right after dismissing
  // elsewhere must work. (Best-effort pin on the hide-timestamp regression —
  // it caught the real ~40ms gap in practice, but Playwright cannot bound
  // the inter-action gap below 50ms, so the gesture guard's real contract is
  // the aborted-press journey below.)
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  // An aborted press must not poison the next keyboard activation: press on
  // the open trigger (light dismiss closes the popover), drag off and
  // release elsewhere — no click ever reaches the trigger, so a naive
  // per-gesture flag would linger. The next Enter has no paired pointerdown
  // and must still toggle the popover open. The release point sits beside
  // the trigger, clear of the popup anchored below it: the spec's light
  // dismiss deliberately ignores gestures whose down/up straddle a popover
  // boundary (drag-out protection), so releasing inside would not dismiss.
  await trigger.press('Enter');
  await expect(dialog).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  if (!triggerBox) throw new Error('trigger has no box');
  await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(triggerBox.x + triggerBox.width + 160, triggerBox.y + triggerBox.height / 2);
  await page.mouse.up();
  await expect(dialog).toBeHidden();
  // `toBeHidden` tracks the DOM (`:popover-open` gone); the attribute tracks
  // React state, which syncs through the layer's queued `toggle` task. Wait
  // for it so Enter lands after the close fully settled.
  await expect(trigger).not.toHaveAttribute('data-popup-open');
  await trigger.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
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
