import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel, type BotProvider } from '@maka/core';
import { feishuOpenApiHost, testBotChannel } from '../bot-test.js';

describe('testBotChannel copy', () => {
  test('all bot platforms now route to a real credential probe, not the planned fallback', async () => {
    // PR-BOT-QQ-CREDENTIALS-TEST-0 + PR-BOT-WECHAT-BRIDGE-0: every
    // BotProvider now has a credential or local-bridge probe. None of
    // them should return the "当前不支持凭据测试" placeholder copy when
    // given empty credentials — they all surface product-specific errors.
    const providers: BotProvider[] = [
      'telegram',
      'discord',
      'feishu',
      'wecom',
      'wechat',
      'dingtalk',
      'qq',
      'slack',
      'whatsapp',
    ];

    for (const provider of providers) {
      const result = await testBotChannel(provider, createDefaultBotChannel(provider));
      assert.equal(result.ok, false, `${provider} should reject empty credentials`);
      assert.doesNotMatch(
        result.error ?? '',
        /当前不支持凭据测试/,
        `${provider} must not surface the planned-fallback placeholder anymore`,
      );
    }
  });

  test('wecom rejects empty credentials with AI-bot product copy (not corp_id/corp_secret)', async () => {
    // PR1197 review (P1-4): WeCom now stores AI-bot Bot ID + Secret, so the
    // empty-credential copy must reflect that shape, not the retired corp probe.
    const result = await testBotChannel('wecom', createDefaultBotChannel('wecom'));
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.match(result.error ?? '', /Bot ID/);
    assert.match(result.error ?? '', /Secret/);
    assert.doesNotMatch(result.error ?? '', /corp_id|corp_secret/);
  });

  test('wecom shape-valid AI-bot credentials pass as unverified without a wrong-endpoint downgrade', async () => {
    // PR1197 review (P1-4): the AI-bot SDK only validates over its WebSocket
    // handshake, so a shape-valid probe must return ok+verified:false and NEVER
    // fail (which would let the settings layer mark a working channel disconnected).
    const result = await testBotChannel('wecom', {
      ...createDefaultBotChannel('wecom'),
      appId: 'bot-123',
      appSecret: 'secret-abc',
    });
    assert.equal(result.ok, true);
    assert.equal(result.verified, false);
    assert.equal(result.identity?.id, 'bot-123');
  });

  test('dingtalk rejects empty credentials with product copy (not a generic "Bot token required")', async () => {
    const result = await testBotChannel('dingtalk', createDefaultBotChannel('dingtalk'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /appkey/);
    assert.match(result.error ?? '', /appsecret/);
  });

  test('wechat rejects non-local bridge URLs instead of treating it as planned', async () => {
    const result = await testBotChannel('wechat', {
      ...createDefaultBotChannel('wechat'),
      webhookUrl: 'https://example.com/wechat-bridge',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /127\.0\.0\.1|localhost/);
    assert.doesNotMatch(
      `${result.error ?? ''} ${result.hint ?? ''}`,
      /当前不支持凭据测试|planned|not implemented|scaffold/i,
    );
  });

  test('feishu credential probe brand-switches the open-platform host by channel domain', () => {
    // PR1197 review (P1-4): a Lark tenant must probe open.larksuite.com, not the
    // feishu.cn host, otherwise a valid Lark channel test wrongly fails.
    assert.equal(feishuOpenApiHost(undefined), 'open.feishu.cn');
    assert.equal(feishuOpenApiHost('feishu.cn'), 'open.feishu.cn');
    assert.equal(feishuOpenApiHost('larksuite.com'), 'open.larksuite.com');
    assert.equal(feishuOpenApiHost(' larksuite.com '), 'open.larksuite.com');
  });

  test('qq rejects empty credentials with product copy (not a generic "Bot token required")', async () => {
    const result = await testBotChannel('qq', createDefaultBotChannel('qq'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /App ID/);
    assert.match(result.error ?? '', /Client Secret/);
  });
});
