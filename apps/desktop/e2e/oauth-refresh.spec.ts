import { expect, test } from './fixtures.js';

test('Codex OAuth completion refreshes the open Settings connection without closing it', async ({
  oauthReloginWindow: page,
}) => {
  const dialog = page.getByRole('dialog', { name: 'OpenAI Codex Fixture' });
  const connectionRow = page.locator('[data-connection-slug="codex-subscription"]');

  await expect(dialog).toBeVisible();
  await expect(connectionRow).toHaveAttribute('title', /需要重新登录/);
  await expect(dialog.getByText('等待 OAuth 登录')).toBeVisible();

  await dialog.getByRole('button', { name: '登录', exact: true }).click();

  // The fixture completes through the real preload/IPC/login-hook path. The
  // detail stays mounted throughout: success must update both its account
  // notice and the connection row behind it, without a close/reopen cycle.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('OAuth 已登录', { exact: true })).toBeVisible();
  await expect(connectionRow).not.toHaveAttribute('title', /需要重新登录/);
  await expect(connectionRow).not.toHaveAttribute('data-disabled', 'true');
});
