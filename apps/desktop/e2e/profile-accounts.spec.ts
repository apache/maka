import type { Page } from '@playwright/test';
import { test, expect, COMPOSER_INPUT } from './fixtures';

/**
 * Credential Profile "Accounts / API Keys" journey against the real runtime
 * host candidate with deterministic provider-effect runners:
 *
 * create secondary -> set credential -> enable -> profile test writes
 * verification -> explicit balanced activation -> UI shows ready/routing.
 *
 * The connection is seeded as providerType 'anthropic' with the default model
 * claude-sonnet-4-5-20250929; the E2E candidate's fake runners verify that
 * model for any profile.
 */
test('profile accounts journey reaches ready accounts and balanced routing', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings).toBeVisible();
  await page
    .getByRole('navigation', { name: /^(设置分组|Settings sections)$/ })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await page.locator('[data-connection-slug="e2e"] button').click();

  const accounts = page.getByRole('region', { name: '账号 / API Keys' });
  await expect(accounts).toBeVisible();

  // 1. Create a secondary profile. It starts disabled and unconfigured.
  await accounts.getByRole('textbox', { name: '名称' }).fill('backup');
  await accounts.getByRole('button', { name: '添加 API Key' }).click();
  await expect(accounts.getByText('backup', { exact: true })).toBeVisible();
  await expect(accounts.getByText('已停用', { exact: true })).toBeVisible();

  // 2. Set the secondary credential (save-time only).
  await accounts.getByRole('button', { name: '更换密钥' }).click();
  await accounts.getByRole('textbox', { name: /粘贴新的 API Key/ }).fill('e2e-backup-key');
  await accounts.getByRole('button', { name: '保存密钥' }).click();
  await expect(accounts.getByText('未配置密钥', { exact: true })).toHaveCount(0);

  // 3. Test the DISABLED profile first: the lifecycle is verify-first,
  // enable-later (RFC 11.1), and the production authority accepts a test for
  // a configured-but-disabled profile. Evidence is written without flipping
  // the enable state.
  await accounts.getByRole('button', { name: '测试' }).nth(1).click();
  await expect(accounts.getByText('已停用', { exact: true })).toBeVisible();

  // 4. Enable the verified secondary: it now shows as ready.
  await accounts.getByRole('button', { name: '启用', exact: true }).click();
  await expect(accounts.getByText('可用', { exact: true })).toBeVisible();

  // 5. Test the primary profile: balanced activation needs TWO verified
  // profiles on one enabled model. The primary row carries a test button too.
  await accounts.getByRole('button', { name: '测试' }).first().click();
  await expect(accounts.getByText('可用', { exact: true })).toHaveCount(2);

  // 6. Explicit balanced activation — adding a profile never flipped this.
  await accounts.getByRole('button', { name: '启用负载均衡' }).click();

  // 7. The routing line reports balancing, and the ready candidate summary
  // counts the model with two available accounts.
  await expect(accounts.getByText('负载均衡已启用', { exact: true })).toBeVisible();
  await expect(accounts.getByText(/已启用均衡/)).toBeVisible();
  await expect(accounts.getByText('主账号', { exact: true })).toBeVisible();
  await expect(accounts.getByText('可用', { exact: true })).toHaveCount(2);
});

test('primary profile cannot be removed and removal confirms the label only', async ({
  window: page,
}) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings).toBeVisible();
  await page
    .getByRole('navigation', { name: /^(设置分组|Settings sections)$/ })
    .getByRole('button', { name: '模型', exact: true })
    .click();
  await page.locator('[data-connection-slug="e2e"] button').click();

  const accounts = page.getByRole('region', { name: '账号 / API Keys' });
  await expect(accounts).toBeVisible();

  // Create a secondary so the routing declaration (and the primary row) exists.
  await accounts.getByRole('textbox', { name: '名称' }).fill('temp-account');
  await accounts.getByRole('button', { name: '添加 API Key' }).click();
  await expect(accounts.getByText('temp-account', { exact: true })).toBeVisible();

  // The primary row shows the primary identity and has no remove control.
  await expect(accounts.getByText('主账号', { exact: true })).toBeVisible();
  await expect(accounts.getByRole('button', { name: '移除' })).toHaveCount(1);

  // Primary is not removable, but it must remain recoverable after an
  // execution-basis change disables every Profile: expose the same explicit
  // disable/enable lifecycle as secondary Profiles.
  await accounts.getByRole('button', { name: '停用', exact: true }).click();
  await expect(accounts.getByRole('button', { name: '启用', exact: true })).toHaveCount(2);
  await accounts.getByRole('button', { name: '启用', exact: true }).first().click();
  await expect(accounts.getByRole('button', { name: '停用', exact: true })).toHaveCount(1);

  // A secondary removal confirms against the label, never a secret.
  await accounts.getByRole('button', { name: '移除' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('temp-account');
  await expect(confirm).not.toContainText('e2e-backup-key');
  await confirm.getByRole('button', { name: '移除账号' }).click();
  await expect(accounts.getByText('temp-account', { exact: true })).toHaveCount(0);
});
