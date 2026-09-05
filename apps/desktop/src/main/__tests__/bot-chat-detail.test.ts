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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, before, test, mock } from 'node:test';
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createDefaultBotChannel } from '@maka/core/bot-chat-settings';
import { MAX_ALLOWED_USER_IDS, createDefaultSettings } from '@maka/core/settings';
import { BotRegistry, SlackBotBridge, WechatBridge, type BotStatus } from '@maka/runtime/bots';
import { UI_LOCALES, type UiCatalog, type UiLocale } from '@maka/core/ui-locale';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as BotChatDetailModule from '../../renderer/settings/bot-chat-detail.js';
import type * as BotChatOverviewModule from '../../renderer/settings/bot-chat-overview.js';
import type * as BotOnboardingModule from '../../renderer/settings/bot-onboarding-modal.js';
import { getBotSettingsCopy } from '../../renderer/locales/settings-bot-copy.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
let outdir: string;
let BotChatChannelDetail: typeof BotChatDetailModule.BotChatChannelDetail;
let BotChatOverview: typeof BotChatOverviewModule.BotChatOverview;
let BotOnboardingModal: typeof BotOnboardingModule.BotOnboardingModal;

before(async () => {
  outdir = await mkdtemp(resolve(REPO_ROOT, 'apps/desktop/dist/main/__tests__/bot-chat-detail-'));
  await build({
    entryPoints: ['bot-chat-detail', 'bot-chat-overview', 'bot-onboarding-modal'].map((name) => resolve(REPO_ROOT, `apps/desktop/src/renderer/settings/${name}.tsx`)),
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  ({ BotChatChannelDetail } = await import(pathToFileURL(resolve(outdir, 'bot-chat-detail.mjs')).href));
  ({ BotChatOverview } = await import(pathToFileURL(resolve(outdir, 'bot-chat-overview.mjs')).href));
  ({ BotOnboardingModal } = await import(pathToFileURL(resolve(outdir, 'bot-onboarding-modal.mjs')).href));
});

after(async () => {
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

const invalidUsers = ['@alice', '@bob', '@carol', '@dave', '@eve'];
const expectedCopy = {
  'zh-CN': {
    help: 'Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。',
    cappedHelp: 'Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。 （已达到上限）',
    warnings: [
      [1, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice'],
      [3, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol'],
      [4, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol 等 4 项'],
      [5, '下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：@alice、@bob、@carol 等 5 项'],
    ],
  },
  'zh-TW': {
    help: 'Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。',
    cappedHelp: 'Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。 （已達到上限）',
    warnings: [
      [1, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice'],
      [3, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol'],
      [4, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol 等 4 項'],
      [5, '下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：@alice、@bob、@carol 等 5 項'],
    ],
  },
  en: {
    help: 'Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored.',
    cappedHelp: 'Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored. (limit reached)',
    warnings: [
      [1, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice'],
      [3, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol'],
      [4, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol and 1 more'],
      [5, 'These entries are not numeric IDs and may be usernames, so they will not match anyone: @alice, @bob, @carol and 2 more'],
    ],
  },
} satisfies UiCatalog<{
  help: string;
  cappedHelp: string;
  warnings: [number, string][];
}>;

for (const locale of UI_LOCALES) {
  const expected = expectedCopy[locale];
  for (const [count, warning] of expected.warnings) {
    test(`${locale}: BotChatChannelDetail renders the full warning for ${count} invalid IDs`, () => {
      assert.deepEqual(renderAllowedUsersDescriptions(locale, invalidUsers.slice(0, count)), [
        expected.help,
        warning,
      ]);
    });
  }

  test(`${locale}: BotChatChannelDetail omits the warning for an empty allowlist`, () => {
    assert.deepEqual(renderAllowedUsersDescriptions(locale, []), [expected.help]);
  });

  for (const count of [MAX_ALLOWED_USER_IDS - 1, MAX_ALLOWED_USER_IDS]) {
    test(`${locale}: BotChatChannelDetail renders the full help for ${count} numeric IDs without a warning`, () => {
      const users = Array.from({ length: count }, (_, index) => String(123456789 + index));
      assert.deepEqual(renderAllowedUsersDescriptions(locale, users), [
        count === MAX_ALLOWED_USER_IDS ? expected.cappedHelp : expected.help,
      ]);
    });
  }
}

function withLocale(locale: UiLocale, children: ReactNode) {
  return createElement(LocaleProvider, {
    locale,
    children: createElement(AstryxLocaleProvider, {
      children: createElement(ToastProvider, { children }),
    }),
  });
}

function detailProps(overrides: Partial<ComponentProps<typeof BotChatChannelDetail>> = {}): ComponentProps<typeof BotChatChannelDetail> {
  return {
    provider: 'telegram',
    channel: createDefaultBotChannel('telegram'),
    status: undefined,
    statusLoadError: null,
    actionBusy: false,
    pendingAction: null,
    restarting: false,
    onBack() {},
    async onUpdateChannel() { return true; },
    onTest() {},
    onTestAndConnect() {},
    onRestart() {},
    onDisconnectSession() {},
    async onReload() {},
    async onRefreshStatuses() { return true; },
    ...overrides,
  };
}

function renderAllowedUsersDescriptions(locale: UiLocale, allowedUserIds: readonly string[]) {
  const markup = renderToStaticMarkup(withLocale(locale, createElement(BotChatChannelDetail, detailProps({ channel: { ...createDefaultBotChannel('telegram'), allowedUserIds } }))));
  const { document } = parseHTML(markup);
  const textarea = document.querySelector('textarea');
  assert.ok(textarea, 'the public detail must render the Telegram allowlist');
  assert.equal(textarea.textContent, allowedUserIds.join('\n'));
  const describedBy = textarea.getAttribute('aria-describedby');
  assert.ok(describedBy, 'the allowlist must reference its help and warning');
  return describedBy.split(/\s+/).map((id) => {
    const description = document.getElementById(id);
    assert.ok(description, `missing allowlist description ${id}`);
    return description.textContent;
  });
}

test('real bridge failures render localized detail and overview output in all locales', async () => {
  const require = createRequire(import.meta.resolve('@maka/runtime/bots'));
  const { WebClient } = require('@slack/web-api') as typeof import('@slack/web-api');
  type SlackSocket = EventEmitter & { start(): Promise<unknown>; disconnect(): Promise<void> };
  const { SocketModeClient } = require('@slack/socket-mode') as { SocketModeClient: new () => SlackSocket };
  const slack = new SlackBotBridge({ ...createDefaultBotChannel('slack'), enabled: true, token: 'bot-secret', appSecret: 'app-secret' });
  let socket: InstanceType<typeof SocketModeClient> | undefined;
  const auth = mock.method(WebClient.prototype, 'apiCall', async () => ({ ok: true, user_id: 'bot' }));
  const start = mock.method(SocketModeClient.prototype, 'start', async function (this: InstanceType<typeof SocketModeClient>) { socket = this; return {}; });
  const stop = mock.method(SocketModeClient.prototype, 'disconnect', async () => {});
  const log = mock.method(console, 'warn', () => {});
  const statuses: Array<[BotStatus, string[]]> = [];
  try {
    await slack.start();
    assert.ok(socket);
    socket.emit('disconnected');
    statuses.push([slack.getStatus(), ['Slack 连接已断开，正在等待重新连接', 'Slack 連線已中斷，正在等待重新連線', 'Slack disconnected; waiting to reconnect']]);
    await slack.stop();
    auth.mock.mockImplementation(async () => { throw new Error('Network error bot-secret app-secret'); });
    await assert.rejects(slack.start());
    assert.equal(slack.getStatus().reason, 'network_error');
    statuses.push([slack.getStatus(), ['网络错误，请检查网络和代理设置', '網路錯誤，請檢查網路和代理設定', 'Network error. Check the network and proxy settings']]);
    const diagnostic = log.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.match(diagnostic, /Network error \[redacted\] \[redacted\]/);
    for (const [url, code] of [['https://remote.invalid', 'wechat_bridge_url_invalid'], ['https://ilinkai.weixin.qq.com', 'wechat_ilink_credentials_incomplete']] as const) {
      const bridge = new WechatBridge({ ...createDefaultBotChannel('wechat'), enabled: true, webhookUrl: url });
      await bridge.start();
      assert.equal(bridge.getStatus().reason, code);
      statuses.push([bridge.getStatus(), UI_LOCALES.map((locale) => code === 'wechat_bridge_url_invalid' ? getBotSettingsCopy(locale).testHints.wechat_bridge_local_only : getBotSettingsCopy(locale).testHints.wechat_ilink_login_required)]);
    }
    for (const [provider, code] of [['slack', 'slack_tokens_missing'], ['wecom', 'wecom_credentials_missing'], ['dingtalk', 'dingtalk_credentials_missing'], ['qq', 'qq_credentials_missing']] as const) {
      const registry = new BotRegistry({ onIncomingMessage() {}, onStatusChange() {} });
      const settings = createDefaultSettings().botChat;
      settings.channels[provider].enabled = true;
      await registry.applySettings(settings);
      statuses.push([registry.getStatus(provider), UI_LOCALES.map((locale) => getBotSettingsCopy(locale).testErrors[code])]);
      await registry.stopAll();
    }
    for (const reason of ['Network error', '外部错误 token=secret', 'constructor', '__proto__', 'toString', 'future-code']) {
      statuses.push([{ ...slack.getStatus(), reason }, UI_LOCALES.map((locale) => getBotSettingsCopy(locale).status.detailsInLogs)]);
    }
    for (const [status, expected] of statuses) {
      for (const [index, locale] of UI_LOCALES.entries()) {
        const channel = { ...createDefaultBotChannel(status.platform), enabled: true };
        const detail = renderToStaticMarkup(withLocale(locale, createElement(BotChatChannelDetail, detailProps({ provider: status.platform, channel, status }))));
        assert.ok(parseHTML(`<html><body>${detail}</body></html>`).document.body.textContent.includes(expected[index]), `${locale}: detail must render ${expected[index]}`);
        const channels = createDefaultSettings().botChat.channels;
        channels[status.platform] = channel;
        const registry = new BotRegistry({ onIncomingMessage() {}, onStatusChange() {} });
        const overview = renderToStaticMarkup(withLocale(locale, createElement(BotChatOverview, { channels, statuses: { ...registry.allStatuses(), [status.platform]: status }, statusLoadError: null, onOpenChannel() {}, async onRefreshStatuses() { return true; } })));
        const summary = parseHTML(overview).document.getElementById(`settings-remote-access-${status.platform}-summary`);
        assert.equal(summary?.textContent, expected[index]);
      }
    }
  } finally {
    await slack.stop();
    auth.mock.restore(); start.mock.restore(); stop.mock.restore(); log.mock.restore();
  }
});

for (const locale of UI_LOCALES) {
  test(`${locale}: onboarding modal and completion toast localize warning details`, async () => {
    const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
    const globals = ['document', 'window', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'Node', 'CSS', 'matchMedia', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
    const previous = Object.fromEntries(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const matchMedia = (media: string) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    Object.assign(window, { matchMedia, scrollTo() {} });
    Object.assign(window.HTMLElement.prototype, { showModal(this: HTMLElement) { this.setAttribute('open', ''); }, close(this: HTMLElement) { this.removeAttribute('open'); } });
    Object.assign(globalThis, { document, window, matchMedia, HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement ?? class {}, Event: window.Event, Node: window.Node, CSS: { escape: (value: string) => value }, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(globalThis, { getComputedStyle: () => ({ backgroundImage: 'none', backgroundColor: 'transparent', getPropertyValue: () => '' }) });
    const root = createRoot(document.getElementById('root')!);
    try {
      for (const reason of ['connections-open-503', 'constructor', '__proto__', 'Network error', '外部错误 token=secret']) {
        const snapshot = { sessionId: reason, provider: 'dingtalk', state: 'connected', warningCode: 'saved_not_connected', warningDetail: reason, nextPollAfterMs: 1000 };
        Object.assign(window, { maka: { settings: { bots: { onboarding: { async start() { return { ok: true, data: snapshot }; }, async cancel() { return { ok: true }; } } } } } });
        await act(async () => { root.render(withLocale(locale, createElement(BotOnboardingModal, { key: reason, provider: 'dingtalk', isOpen: true, onOpenChange() {}, onConnected() {} }))); });
        const copy = getBotSettingsCopy(locale);
        const expected = copy.onboarding.savedNotConnectedDetail(reason === 'connections-open-503' ? copy.statusReasons.withCode.connectionsOpen('503') : copy.status.detailsInLogs);
        assert.equal(document.querySelector('.settingsBotOnboardingStatus')?.textContent, expected);
      }
      for (const code of ['network_error', 'future-code', 'constructor', '__proto__', 'toString']) {
        const snapshot = { sessionId: code, provider: 'dingtalk', state: 'error', errorCode: code, error: 'raw external error token=secret', nextPollAfterMs: 1000 };
        Object.assign(window, { maka: { settings: { bots: { onboarding: { async start() { return { ok: true, data: snapshot }; }, async cancel() { return { ok: true }; } } } } } });
        await act(async () => { root.render(withLocale(locale, createElement(BotOnboardingModal, { key: `error-${code}`, provider: 'dingtalk', isOpen: true, onOpenChange() {}, onConnected() {} }))); });
        const copy = getBotSettingsCopy(locale).onboarding;
        assert.equal(document.querySelector('.settingsBotOnboardingStatus')?.textContent, code === 'network_error' ? copy.errors.network_error : copy.failed);
      }
      for (const reason of ['connections-open-503', '外部错误 token=secret']) {
        await act(async () => root.render(null));
        const snapshot = { sessionId: reason, provider: 'dingtalk', state: 'connected', warningCode: 'saved_not_connected', warningDetail: reason, nextPollAfterMs: 1000 };
        Object.assign(window, { maka: { settings: { bots: { onboarding: { async start() { return { ok: true, data: snapshot }; }, async cancel() { return { ok: true }; } } } } } });
        await act(async () => { root.render(withLocale(locale, createElement(BotChatChannelDetail, detailProps({ provider: 'dingtalk', channel: createDefaultBotChannel('dingtalk') })))); });
        const copy = getBotSettingsCopy(locale);
        const button = [...document.querySelectorAll('button')].find((button) => button.textContent === copy.detail.scanConnect);
        assert.ok(button);
        await act(async () => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
        const toast = document.querySelector('[data-toast-id]');
        assert.ok(toast, 'completion must render a warning toast');
        assert.ok(toast.textContent.includes(copy.onboarding.savedNotConnectedDetail(reason === 'connections-open-503' ? copy.statusReasons.withCode.connectionsOpen('503') : copy.status.detailsInLogs)));
        assert.ok(!document.body.textContent.includes('token=secret'));
      }
    } finally {
      await act(async () => root.unmount());
      for (const key of globals) {
        const descriptor = previous[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
