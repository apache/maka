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
  // fires on pointerdown and the trailing click must not re-open it (the
  // upstream lastHideTime guard). Hold the assertion past the race window.
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
  // settling wait before this click: a re-open right after dismissing
  // elsewhere must work — the gesture guard must not swallow it the way a
  // hide-timestamp window would.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
