import { test, expect } from './fixtures';

test('IM 快捷接入完成真实 QR session、扫码状态和本机凭据落盘', async ({ botSettingsWindow: page }) => {
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

  // A QR code the user cannot fully see cannot be scanned. What that requires is
  // a relationship, not a fixed size: the image fills its frame (so it is never
  // shrunk to a corner of it), the frame is square, the code is wholly on screen
  // at a scannable size, and the dialog stays inside the window. The frame's
  // 284px and the dialog's 522px cap are the design tokens; these are not.
  //
  // `toBeInViewport()` alone would NOT carry this: its default `ratio: 0` passes
  // on any positive intersection, so a QR with one corner on screen clears it.
  const dialogBox = await dialog.boundingBox();
  const qrFrameBox = await dialog.locator('.settingsBotOnboardingQrFrame').boundingBox();
  const qrBox = await qr.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(dialogBox).not.toBeNull();
  expect(qrFrameBox).not.toBeNull();
  expect(qrBox).not.toBeNull();

  // The image fills its frame, up to the frame's 1px border on each side.
  expect(qrFrameBox!.width - qrBox!.width).toBeLessThanOrEqual(2);
  expect(qrFrameBox!.height - qrBox!.height).toBeLessThanOrEqual(2);
  // Square, and large enough for a phone camera to resolve the modules.
  expect(Math.abs(qrBox!.width - qrBox!.height)).toBeLessThanOrEqual(1);
  expect(qrBox!.width).toBeGreaterThanOrEqual(160);
  // Centred in the dialog it belongs to.
  expect(
    Math.abs((dialogBox!.x + dialogBox!.width / 2) - (qrBox!.x + qrBox!.width / 2)),
  ).toBeLessThan(2);
  // Wholly on screen — every edge, not merely intersecting.
  await expect(qr).toBeInViewport({ ratio: 1 });
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(viewport.height);

  await expect(dialog.getByText('已扫码，请在钉钉中完成确认')).toBeVisible({ timeout: 4_000 });
  await expect(dialog.getByText('钉钉 已连接')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Maka 测试机器人')).toBeVisible();

  const stored = await page.evaluate(() => window.maka.settings.get());
  expect(stored.botChat.channels.dingtalk.appId).toBe('e2e-fixture-dingtalk-client');
  expect(stored.botChat.channels.dingtalk.appSecret).not.toBe('e2e-fixture-dingtalk-secret');
  expect(JSON.stringify(stored)).not.toContain('e2e-fixture-dingtalk-secret');

  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toBeHidden();
});

test('关闭扫码弹窗会取消迟到结果，过期二维码可以重新生成', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '接入 微信' }).click();
  await settings.getByRole('button', { name: '扫码登录' }).click();
  const wechatDialog = page.getByRole('dialog', { name: '微信扫码登录' });
  await expect(wechatDialog.getByRole('img', { name: '微信扫码登录二维码' })).toBeVisible();
  await page.waitForTimeout(1_150);
  // The fixture deliberately has a provider result in flight here. Bypass
  // Playwright's stability wait so the result-driven rerender cannot win the
  // race before the cancellation click is dispatched.
  await wechatDialog.getByRole('button', { name: '取消' }).click({ force: true });
  await expect(wechatDialog).toBeHidden();
  await page.waitForTimeout(1_300);

  const afterCancel = await page.evaluate(() => window.maka.settings.get());
  expect(afterCancel.botChat.channels.wechat.token).toBe('');
  expect(afterCancel.botChat.channels.wechat.enabled).toBe(false);

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 企业微信' }).click();
  await settings.getByRole('button', { name: '开始快捷绑定' }).click();
  const wecomDialog = page.getByRole('dialog', { name: '配置企业微信扫码接入' });
  await expect(wecomDialog.getByRole('img', { name: '配置企业微信二维码' })).toBeVisible();
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

test('QQ 完成扫码接入和 secret 隔离', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '接入 QQ' }).click();
  await settings.getByRole('button', { name: '使用QQ扫码接入' }).click();
  const qqDialog = page.getByRole('dialog', { name: '配置 QQ 扫码接入' });
  await expect(qqDialog.getByRole('img', { name: '配置 QQ 二维码' })).toBeVisible();
  await expect(qqDialog.getByText('已扫码，请在 QQ 中完成确认')).toBeVisible({ timeout: 4_000 });
  await expect(qqDialog.getByText('QQ 已连接')).toBeVisible({ timeout: 5_000 });

  const afterQq = await page.evaluate(() => window.maka.settings.get());
  expect(afterQq.botChat.channels.qq.appId).toBe('e2e-fixture-qq-app');
  expect(afterQq.botChat.channels.qq.appSecret).not.toBe('e2e-fixture-qq-secret');
  expect(JSON.stringify(afterQq)).not.toContain('e2e-fixture-qq-secret');
  await qqDialog.getByRole('button', { name: '完成' }).click();
});

test('Slack 展示完整 Socket Mode 凭据，Telegram 明示官方 Token 流程', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '接入 Slack' }).click();
  await expect(settings.getByRole('textbox', { name: /Slack Bot Token/ })).toBeVisible();
  await expect(settings.getByRole('textbox', { name: /Slack App-Level Token/ })).toBeVisible();
  await expect(settings.getByText('使用 Bot Token 与 App-Level Token 通过 Socket Mode 接入')).toBeVisible();

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 Telegram' }).click();
  await expect(settings.getByRole('textbox', { name: /Telegram Bot Token/ })).toBeVisible();
  await expect(settings.getByText(/Telegram 官方目前仅支持通过 @BotFather 获取 Bot Token/)).toBeVisible();
});
