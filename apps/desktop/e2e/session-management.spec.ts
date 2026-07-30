import { test, expect } from './fixtures';

/**
 * Session management: a second chat can be created without clobbering the
 * first, and both are listed in the sidebar (empty sessions are filtered out
 * by lastMessageAt, so B only appears once it has a message).
 *
 * Switching back to A via the sidebar row is left for a follow-up: rows can
 * sit inside a collapsed status group, so driving that interaction needs the
 * list's expand/group behavior pinned down first — a flaky click would be
 * worse than no assertion.
 */
test('creating a second chat keeps both in the sidebar', async ({ window: page }) => {
  const composer = page.locator('.maka-composer-textarea');
  await composer.fill('alpha-marker');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: alpha-marker/)).toBeVisible();

  const sessions = page.locator('aside[aria-label="对话列表"] [data-session-id]');
  await expect(sessions).toHaveCount(1);

  await page.getByRole('button', { name: '新任务' }).click();
  await expect(page.getByRole('region', { name: '开始对话' })).toBeVisible();
  await composer.fill('beta-marker');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: beta-marker/)).toBeVisible();

  await expect(sessions).toHaveCount(2);
});
