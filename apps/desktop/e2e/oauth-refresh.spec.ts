import { expect, test } from './fixtures.js';

test('Codex OAuth completion refreshes the open connection detail without leaving it', async ({
  oauthReloginWindow: page,
}) => {
  const detail = page.locator('[data-maka-contract="connection-detail"]');

  await expect(detail).toBeVisible();
  await expect(detail.getByText('等待 OAuth 登录')).toBeVisible();

  await detail.getByRole('button', { name: '登录', exact: true }).click();

  // The fixture completes through the real preload/IPC/login-hook path. The
  // detail stays on screen throughout: success must update it in place, with
  // no bounce back to the list and no close/reopen cycle.
  await expect(detail).toBeVisible();
  await expect(detail.getByText('OAuth 已登录', { exact: true })).toBeVisible();

  // And the refresh reached the backing list, not just the page in front of
  // it: the row is healthy on return.
  await page.getByRole('button', { name: '返回模型连接', exact: true }).click();
  const connectionRow = page.locator('[data-connection-slug="codex-subscription"]');
  await expect(connectionRow).toBeVisible();
  await expect(connectionRow).not.toContainText('需要重新登录');
  await expect(connectionRow).not.toHaveAttribute('data-disabled', 'true');
});
