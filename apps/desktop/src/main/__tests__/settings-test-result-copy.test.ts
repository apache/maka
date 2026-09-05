/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { settingsTestResultMessage } from "../../renderer/locales/settings-test-result-copy.js";
import { toSettingsTestResult } from "../settings-ipc-helpers.js";
import { createDefaultBotChannel, type BotProvider } from '@maka/core/bot-chat-settings';
import { UI_LOCALES } from '@maka/core/ui-locale';
import { BotRegistry, testBotChannel, WechatBridge, testWechatIlinkCredentials, type BotTestErrorCode } from '@maka/runtime/bots';
import { createDefaultSettings, mergeSettings, type SettingsTestResult, type UpdateAppSettingsInput } from '@maka/core/settings';
import type { SettingsStore } from '@maka/storage/settings-store';
import type { IpcMain } from 'electron';
import { registerSettingsBotsIpc } from '../settings-bots-ipc-main.js';
import { createRequire } from 'node:module';
import { botStatusReasonMessage, getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';

test("missing proxy credentials have actionable bilingual copy", () => {
  const result = {
    ok: false,
    code: "proxy_credential_missing",
    message: "Proxy credential is not configured",
  } as never;

  assert.equal(
    settingsTestResultMessage(result, "zh-CN"),
    "代理认证已开启，请输入代理密码后再测试。",
  );
  assert.equal(
    settingsTestResultMessage(result, "en"),
    "Proxy authentication is enabled. Enter a proxy password before testing.",
  );
});


test("renders a bot-test error code per locale without content sniffing", () => {
  const result = toSettingsTestResult("feishu", {
    ok: false,
    errorCode: "feishu_credentials_missing",
  });
  assert.equal(result.code, "bot_app_credentials_missing");
  assert.equal(settingsTestResultMessage(result, "zh-CN"), "请填写 App ID 和 App Secret 后再测试。");
  assert.equal(
    settingsTestResultMessage(result, "en"),
    "Enter an App ID and App Secret before testing the connection.",
  );
});

test('WeChat failed probe survives start and localized status presentation', async () => {
  const bridge = new WechatBridge({
    ...createDefaultBotChannel('wechat'), enabled: true, webhookUrl: 'https://remote.invalid',
  });
  const statuses: string[] = [];
  bridge.on('statusChange', (status) => statuses.push(status.reason));
  await bridge.start();
  assert.equal(bridge.getStatus().reason, 'wechat_bridge_url_invalid');
  assert.deepEqual(statuses, ['wechat_bridge_url_invalid']);
  for (const locale of UI_LOCALES) {
    assert.equal(botStatusReasonMessage(bridge.getStatus().reason, locale), getBotSettingsCopy(locale).testHints.wechat_bridge_local_only);
    const probe = await testWechatIlinkCredentials(createDefaultBotChannel('wechat'));
    const result = toSettingsTestResult('wechat', probe);
    assert.equal(result.code, 'wechat_ilink_credentials_incomplete');
    assert.equal(settingsTestResultMessage(result, locale), getBotSettingsCopy(locale).testHints.wechat_ilink_login_required);
  }
});

test('missing credentials retain provider-specific fields through the adapter in all locales', async () => {
  for (const [provider, code, fields] of [
    ['slack', 'slack_tokens_missing', ['Bot Token', 'App-Level Token']],
    ['wecom', 'wecom_credentials_missing', ['Bot ID', 'Secret']],
    ['dingtalk', 'dingtalk_credentials_missing', ['AppKey', 'Client Secret']],
    ['qq', 'qq_credentials_missing', ['App ID', 'AppSecret']],
  ] as const) {
    const result = toSettingsTestResult(provider, await testBotChannel(provider, createDefaultBotChannel(provider)));
    assert.equal(result.code, code);
    for (const locale of UI_LOCALES) {
      const message = settingsTestResultMessage(result, locale);
      for (const field of fields) assert.ok(message.includes(field), `${locale}: ${message}`);
      assert.ok(!message.includes('App Secret'), message);
    }
  }
});

test('Telegram credential rejection is distinct from transient and malformed responses', async () => {
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(import.meta.resolve('@maka/runtime/bots'))('undici') as typeof import('undici');
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const token = '12345:test-token-secret';
  const log = mock.method(console, 'warn', () => {});
  try {
    for (const [status, body, expected] of [
      [429, { ok: false, error_code: 429, description: `retry token=${token}` }, 'connection_failed'],
      [401, { ok: false, error_code: 401 }, 'token_invalid'],
      [200, { ok: false, error_code: 401 }, 'token_invalid'],
      [500, { ok: false, error_code: 500 }, 'connection_failed'],
      [503, { ok: false, error_code: 401 }, 'connection_failed'],
      [403, { ok: false, error_code: 403 }, 'connection_failed'],
      [200, { ok: false }, 'connection_failed'],
      [503, 'not JSON', 'connection_failed'],
    ] as const) {
      agent.get('https://api.telegram.org').intercept({ path: `/bot${token}/getMe`, method: 'GET' }).reply(status, body);
      const probe = await testBotChannel('telegram', { ...createDefaultBotChannel('telegram'), token });
      agent.assertNoPendingInterceptors();
      assert.equal(probe.errorCode, expected, `HTTP ${status}`);
      assert.ok(probe.error, `HTTP ${status} must retain a diagnostic fallback`);
      assert.ok(!probe.error.includes(token));
      const result = toSettingsTestResult('telegram', probe);
      for (const locale of UI_LOCALES) {
        const message = settingsTestResultMessage(result, locale);
        assert.ok(message.length > 0);
        assert.ok(!message.includes(token));
        assert.equal(result.code === 'bot_token_invalid', expected === 'token_invalid');
      }
    }
    agent.get('https://api.telegram.org').intercept({ path: `/bot${token}/getMe`, method: 'GET' }).replyWithError(new Error(`Network error ${token}`));
    const network = await testBotChannel('telegram', { ...createDefaultBotChannel('telegram'), token });
    agent.assertNoPendingInterceptors();
    assert.equal(network.errorCode, 'connection_failed');
    const diagnostic = log.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.match(diagnostic, /retry token=\[redacted\]/);
    assert.ok(!diagnostic.includes(token));
  } finally {
    log.mock.restore();
    setGlobalDispatcher(previous);
    await agent.close();
  }
});

test('settings IPC persists stable failure codes consumed by status presenters', async () => {
  let settings = createDefaultSettings();
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const handle = registerSettingsBotsIpc({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    settingsStore: {
      async get() { return settings; },
      async update(patch: UpdateAppSettingsInput) { settings = mergeSettings(settings, patch); return settings; },
    } as SettingsStore,
    botRegistry: new BotRegistry({ onIncomingMessage() {}, onStatusChange() {} }),
    async applySettingsRuntimeEffects() {},
    productVersion: 'test',
    async openExternal() {},
  });
  try {
    const testChannel = handlers.get('settings:testBotChannel');
    assert.ok(testChannel);
    for (const provider of ['slack', 'telegram', 'dingtalk', 'qq'] as const) {
      const result = await testChannel({} as never, provider) as SettingsTestResult;
      const channel = settings.botChat.channels[provider];
      const probe = await testBotChannel(provider, channel);
      assert.equal(channel.lastError, probe.errorCode);
      assert.equal(channel.readinessReason, probe.errorCode);
      for (const locale of UI_LOCALES) assert.equal(botStatusReasonMessage(channel.lastError, locale), settingsTestResultMessage(result, locale));
    }
  } finally { handle.dispose(); }
});

for (const locale of UI_LOCALES) {
  test(`${locale}: every producer error code has matching settings and status copy`, () => {
    const providers = {
      connection_failed: 'telegram', token_missing: 'telegram', token_invalid: 'telegram',
      slack_tokens_missing: 'slack', feishu_credentials_missing: 'feishu',
      wecom_credentials_missing: 'wecom', dingtalk_credentials_missing: 'dingtalk',
      dingtalk_no_access_token: 'dingtalk', qq_credentials_missing: 'qq',
      qq_no_access_token: 'qq', wechat_bridge_url_invalid: 'wechat',
      wechat_ilink_credentials_incomplete: 'wechat',
    } satisfies Record<BotTestErrorCode, BotProvider>;
    for (const [code, provider] of Object.entries(providers)) {
      const result = toSettingsTestResult(provider, { ok: false, errorCode: code as BotTestErrorCode });
      const message = settingsTestResultMessage(result, locale);
      assert.equal(message, botStatusReasonMessage(code, locale), code);
      assert.notEqual(message, getBotSettingsCopy(locale).status.detailsInLogs, code);
    }
  });
  test(`${locale}: unknown status and settings codes never render arbitrary diagnostics or inherited keys`, () => {
    for (const reason of ['Network error', '外部错误 token=secret', 'Bad Request: chat not found', 'future-code', 'constructor', 'toString', '__proto__']) {
      assert.equal(botStatusReasonMessage(reason, locale), getBotSettingsCopy(locale).status.detailsInLogs);
      assert.equal(settingsTestResultMessage({ ok: false, code: reason as never, message: reason }, locale), settingsTestResultMessage({ ok: false, code: 'bot_connection_failed', message: '' }, locale));
      assert.equal(toSettingsTestResult('slack', { ok: false, errorCode: reason as never, error: reason }).code, 'bot_connection_failed');
    }
    assert.equal(botStatusReasonMessage(undefined, locale), undefined);
    assert.notEqual(botStatusReasonMessage('slack-disconnected', locale), 'slack-disconnected');
  });
}
