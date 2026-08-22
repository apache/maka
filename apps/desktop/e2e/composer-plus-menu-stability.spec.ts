import { expect, test, waitForInvocableSkills } from './fixtures';

/**
 * Toggling Plan from the ＋ menu must not move the menu.
 *
 * The toggle changes the new chat's collaboration mode, which re-fetches the
 * invocable-Skill projection. That refresh clears the list fail-closed for the
 * `/` popup, and the regression this spec pins is the Skills row reading the
 * transient `[]` as "no skills available": it grayed out and grew a
 * description line for the length of the round trip, so the open menu's
 * geometry blinked on every Plan click (MatrixA/fix-plan-click-flicker).
 *
 * The watcher is armed in-page BEFORE the click: the blink lives inside one
 * IPC round trip and is gone by the time a polling assertion could look.
 */

interface PlusMenuWatch {
  noSkillsTextAppeared: boolean;
  skillsRowDisabled: boolean;
  planRowDisabled: boolean;
  heights: number[];
}

declare global {
  interface Window {
    __plusMenuWatch?: PlusMenuWatch;
    __plusMenuWatchStop?: () => void;
  }
}

test('toggling Plan keeps the ＋ menu open, enabled and the same size', async ({
  invocableSkillsWindow: page,
}) => {
  await page.getByRole('button', { name: '添加上下文' }).click();
  const menu = page.getByRole('menu', { name: '添加上下文' });
  await expect(menu).toBeVisible();

  const planRow = menu.getByRole('menuitemcheckbox', { name: 'Plan' });
  const skillsRow = menu.getByRole('menuitem', { name: /选择技能/ });
  await expect(planRow).toHaveAttribute('aria-checked', 'false');
  // The seeded catalog has settled before the fixture yields the page, so the
  // baseline is an enabled row with no caveat — what must survive the toggle.
  await expect(skillsRow).not.toHaveAttribute('aria-disabled', 'true');
  await expect(menu).not.toContainText('当前没有可用技能');

  // The layer scales in on open (translate + scale 0.95 → 1), and a bounding
  // box read mid-entrance is smaller than the resting one. Let the entrance
  // finish so the recorded baseline is the height the menu must keep.
  await menu.evaluate(async (menuElement) => {
    const layer = menuElement.closest('[popover]') ?? menuElement;
    await Promise.all(
      layer.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });

  await menu.evaluate((menuElement) => {
    const watch: PlusMenuWatch = {
      noSkillsTextAppeared: false,
      skillsRowDisabled: false,
      planRowDisabled: false,
      heights: [menuElement.getBoundingClientRect().height],
    };
    const inspect = () => {
      if (menuElement.textContent?.includes('当前没有可用技能')) {
        watch.noSkillsTextAppeared = true;
      }
      for (const row of menuElement.querySelectorAll('[aria-disabled="true"]')) {
        if (row.textContent?.includes('选择技能')) watch.skillsRowDisabled = true;
        if (row.getAttribute('role') === 'menuitemcheckbox') watch.planRowDisabled = true;
      }
      const height = menuElement.getBoundingClientRect().height;
      const last = watch.heights[watch.heights.length - 1] ?? height;
      if (Math.abs(height - last) > 0.5) watch.heights.push(height);
    };
    const observer = new MutationObserver(inspect);
    observer.observe(menuElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    window.__plusMenuWatch = watch;
    window.__plusMenuWatchStop = () => {
      inspect();
      observer.disconnect();
    };
  });

  await planRow.click();
  await expect(planRow).toHaveAttribute('aria-checked', 'true');
  // The mode mark lands on the footer while the menu stays where it was.
  await expect(page.locator('.maka-composer-mode-button[data-mode="plan"]')).toBeVisible();
  await expect(menu).toBeVisible();

  await planRow.click();
  await expect(planRow).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.maka-composer-mode-button[data-mode="plan"]')).toHaveCount(0);
  await expect(menu).toBeVisible();

  // Both refreshes the two toggles kicked off have reached the backend once
  // this resolves; the margin covers the renderer commit that follows.
  await waitForInvocableSkills(page, ['project-only', 'workspace-only']);
  await page.waitForTimeout(250);

  const watch = await page.evaluate(() => {
    window.__plusMenuWatchStop?.();
    return window.__plusMenuWatch;
  });
  expect(watch, 'the in-page watcher survived the journey').toBeTruthy();
  expect(watch?.noSkillsTextAppeared, 'no transient "no skills" line').toBe(false);
  expect(watch?.skillsRowDisabled, 'the Skills row never grayed out').toBe(false);
  expect(watch?.planRowDisabled, 'the Plan row never grayed out').toBe(false);
  expect(watch?.heights, 'the menu kept one height throughout').toHaveLength(1);
});
