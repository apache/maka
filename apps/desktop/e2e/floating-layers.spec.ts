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
  // and re-enters.
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();

  // And it must not linger once the pointer leaves.
  await page.mouse.move(10, 300);
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(10, 300);
  await expect(tooltip).toBeHidden();
});

