import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import { SENSITIVE_PLACEHOLDER } from '@maka/core/settings/network-settings';
import {
  botTestErrorMessage,
  buildSettingsUpdateResult,
  maskAppSettings,
  preserveSensitivePlaceholders,
  toSettingsTestResult,
} from '../settings-ipc-helpers.js';

describe('settings IPC helpers', () => {
  test('masks sensitive network and bot fields before returning settings to renderer', () => {
    const settings = createDefaultSettings();
    settings.network.proxy.password = 'proxy-secret';
    settings.botChat.channels.telegram.token = 'telegram-secret';
    settings.botChat.channels.feishu.appSecret = 'feishu-secret';

    const masked = maskAppSettings(settings);

    assert.equal(masked.network.proxy.password, SENSITIVE_PLACEHOLDER);
    assert.equal(masked.botChat.channels.telegram.token, SENSITIVE_PLACEHOLDER);
    assert.equal(masked.botChat.channels.feishu.appSecret, SENSITIVE_PLACEHOLDER);
    assert.equal(settings.network.proxy.password, 'proxy-secret');
  });

  test('keeps empty sensitive fields empty instead of showing a placeholder', () => {
    const settings = createDefaultSettings();

    const masked = maskAppSettings(settings);

    assert.equal(masked.network.proxy.password, '');
    assert.equal(masked.botChat.channels.telegram.token, '');
  });

  test('marks Tavily environment credentials as renderer-safe source without returning the key', () => {
    const previous = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'tvly-env-secret';
    try {
      const settings = createDefaultSettings();
      const masked = maskAppSettings(settings);

      assert.equal(masked.webSearch.providers.tavily.apiKey, '');
      assert.equal(masked.webSearch.providers.tavily.credentialSource, 'env');
    } finally {
      if (previous === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = previous;
    }
  });

  test('reveals sensitive fields only when the current patch explicitly changes them', () => {
    const settings = createDefaultSettings();
    settings.network.proxy.password = 'new-proxy-secret';
    settings.botChat.channels.telegram.token = 'new-bot-token';
    settings.botChat.channels.feishu.appSecret = 'stored-feishu-secret';

    const masked = maskAppSettings(settings, {
      network: { proxy: { password: 'new-proxy-secret' } },
      botChat: { channels: { telegram: { token: 'new-bot-token' } } },
    });

    assert.equal(masked.network.proxy.password, 'new-proxy-secret');
    assert.equal(masked.botChat.channels.telegram.token, 'new-bot-token');
    assert.equal(masked.botChat.channels.feishu.appSecret, SENSITIVE_PLACEHOLDER);
  });

  test('never reveals Tavily API key back to renderer, even on the save response', () => {
    const settings = mergeSettings(createDefaultSettings(), {
      webSearch: { providers: { tavily: { apiKey: 'tvly-new-secret' } } },
    });

    const masked = maskAppSettings(settings, {
      webSearch: { providers: { tavily: { apiKey: 'tvly-new-secret' } } },
    });

    assert.equal(masked.webSearch.providers.tavily.apiKey, SENSITIVE_PLACEHOLDER);
    assert.equal(masked.webSearch.providers.tavily.credentialSource, 'saved');
  });

  test('preserves placeholder values as stored secrets before persisting patches', () => {
    const current = createDefaultSettings();
    current.network.proxy.password = 'stored-proxy-secret';
    current.botChat.channels.telegram.token = 'stored-bot-token';
    current.botChat.channels.feishu.appSecret = 'stored-feishu-secret';

    const patch = preserveSensitivePlaceholders(
      {
        network: { proxy: { password: SENSITIVE_PLACEHOLDER, host: '10.0.0.2' } },
        botChat: {
          channels: {
            telegram: { token: SENSITIVE_PLACEHOLDER, enabled: true },
            feishu: { appSecret: SENSITIVE_PLACEHOLDER, appId: 'cli_123' },
          },
        },
      },
      current,
    );

    assert.equal(patch.network?.proxy?.password, 'stored-proxy-secret');
    assert.equal(patch.network?.proxy?.host, '10.0.0.2');
    assert.equal(patch.botChat?.channels?.telegram?.token, 'stored-bot-token');
    assert.equal(patch.botChat?.channels?.telegram?.enabled, true);
    assert.equal(patch.botChat?.channels?.feishu?.appSecret, 'stored-feishu-secret');
    assert.equal(patch.botChat?.channels?.feishu?.appId, 'cli_123');
  });

  test('maps runtime bot test results as credential checks, not operational readiness', () => {
    const result = toSettingsTestResult('telegram', {
      ok: true,
      identity: { id: '42', username: 'maka_bot', displayName: 'Maka' },
      hint: 'ready',
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, 'telegram 凭据测试成功：maka_bot。这不代表运行态已接收或发送成功。');
    assert.deepEqual(result.details?.identity, { id: '42', username: 'maka_bot', displayName: 'Maka' });
    assert.equal(result.details?.hint, 'ready');
  });

  test('redacts and generalizes bot test errors before returning SettingsTestResult', () => {
    const result = toSettingsTestResult('telegram', {
      ok: false,
      error: '401 Authorization: Bearer sk-live-secret-token-value',
    });

    assert.equal(result.message, 'Telegram 连接测试失败：鉴权失败。');
    assert.equal(JSON.stringify(result).includes('sk-live-secret-token-value'), false);
  });

  test('bot test error copy is Chinese and actionable for empty credentials', () => {
    assert.equal(botTestErrorMessage('qq', 'Bot connection test failed'), 'QQ 连接测试失败，请检查凭据和网络后重试。');
    assert.equal(botTestErrorMessage('telegram', 'Bot token is required'), 'Telegram 需要 Bot Token，请填写后再测试。');
    assert.equal(botTestErrorMessage('feishu', 'Feishu appId and appSecret are required'), '飞书需要 App ID 和 App Secret，请填写后再测试。');
  });

  test('settings update result wraps settings and omits warnings for normal personalization', () => {
    const settings = createDefaultSettings();
    settings.personalization.assistantTone = '请简洁一点。';

    const result = buildSettingsUpdateResult(settings, {
      personalization: { assistantTone: '请简洁一点。' },
    });

    assert.equal(result.settings.personalization.assistantTone, '请简洁一点。');
    assert.equal(result.warnings, undefined);
  });

  test('settings update result returns transient personalization warning enums without raw phrases', () => {
    const settings = createDefaultSettings();
    settings.personalization.displayName = 'Alice SYSTEM: root';
    settings.personalization.assistantTone = 'SYSTEM: root api_key sk-live-secret-token-value';

    const result = buildSettingsUpdateResult(settings, {
      personalization: {
        displayName: 'Alice\nSYSTEM: root',
        assistantTone: 'SYSTEM: root api_key sk-live-secret-token-value',
      },
    });

    assert.deepEqual(result.warnings?.personalization, [
      'override-attempt',
      'sensitive-pattern',
      'control-chars',
    ]);
    assert.equal(JSON.stringify(result.warnings).includes('sk-live-secret-token-value'), false);
  });
});
