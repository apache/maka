import { test, expect } from './fixtures';

test('IM 快捷接入完成真实 QR session、凭据落盘，取消与过期二维码可恢复', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '远程接入' })).toBeVisible();

  await settings.getByRole('button', { name: '接入 钉钉' }).click();
  await expect(settings.getByRole('heading', { name: '接入方式' })).toBeVisible();
  await expect(settings.getByRole('radio', { name: '快捷接入（推荐）' })).toBeChecked();

  await settings.getByRole('radio', { name: '手动配置' }).click();
  await expect(settings.getByRole('textbox', { name: '钉钉应用密钥' })).toBeVisible();
  await settings.getByRole('radio', { name: '快捷接入（推荐）' }).click();
  await settings.getByRole('button', { name: '使用钉钉扫码接入' }).click();

  const dialog = page.getByRole('dialog', { name: '配置钉钉扫码接入' });
  await expect(dialog).toBeVisible();
  const qr = dialog.getByRole('img', { name: '配置钉钉二维码' });
  await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(dialog.getByText('请使用钉钉扫描二维码并确认授权')).toBeVisible();
  // QR square / fill-frame geometry is pinned in chat-shell-layout-contract
  // (settingsBotOnboardingQrFrame CSS). This journey owns session + secret isolation.

  await expect(dialog.getByText('已扫码，请在钉钉中完成确认')).toBeVisible({ timeout: 4_000 });
  await expect(dialog.getByText('钉钉 已连接')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Maka 测试机器人')).toBeVisible();

  const stored = await page.evaluate(() => window.maka.settings.get());
  expect(stored.botChat.channels.dingtalk.appId).toBe('e2e-fixture-dingtalk-client');
  expect(stored.botChat.channels.dingtalk.appSecret).not.toBe('e2e-fixture-dingtalk-secret');
  expect(JSON.stringify(stored)).not.toContain('e2e-fixture-dingtalk-secret');

  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toBeHidden();
  // Same window, next channels: cancellation races, expiry regeneration, and
  // the Lark variant are independent flows over the same seeded settings.
  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 微信' }).click();
  await settings.getByRole('button', { name: '扫码登录' }).click();
  const wechatDialog = page.getByRole('dialog', { name: '微信扫码登录' });
  await expect(wechatDialog.getByRole('img', { name: '微信扫码登录二维码' })).toBeVisible();
  // Poll snapshots replace the dialog subtree. A real pointer dispatch does
  // not wait for that subtree to become stable, so neither should this click.
  await wechatDialog.getByRole('button', { name: '取消' }).click({ force: true });
  await expect(wechatDialog).toBeHidden();

  const afterCancel = await page.evaluate(() => window.maka.settings.get());
  expect(afterCancel.botChat.channels.wechat.token).toBe('');
  expect(afterCancel.botChat.channels.wechat.enabled).toBe(false);

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 企业微信' }).click();
  await settings.getByRole('button', { name: '开始快捷绑定' }).click();
  const wecomDialog = page.getByRole('dialog', { name: '配置企业微信扫码接入' });
  await expect(wecomDialog.getByText('二维码已过期，请重新生成')).toBeVisible({ timeout: 4_000 });
  await wecomDialog.getByRole('button', { name: '重新生成' }).click();
  await expect(wecomDialog.getByRole('img', { name: '配置企业微信二维码' })).toBeVisible();
  await wecomDialog.getByRole('button', { name: '取消' }).click({ force: true });

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 飞书' }).click();
  await settings.getByRole('radio', { name: 'Lark' }).click();
  await settings.getByRole('button', { name: '使用Lark扫码接入' }).click();
  const larkDialog = page.getByRole('dialog', { name: '配置 Lark 扫码接入' });
  await expect(larkDialog.getByRole('img', { name: '配置 Lark 二维码' })).toBeVisible();
});
