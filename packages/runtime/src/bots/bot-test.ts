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

import { botDisplayLabel } from '@maka/core/bot-events';
import { type BotChannelSettings, type BotProvider } from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { WebClient } from '@slack/web-api';
import type { BotTestResult } from './types.js';
import { proxiedFetch } from './proxied-fetch.js';
import {
  normalizeWechatIlinkBaseUrl,
  testWechatBridge,
  testWechatIlinkCredentials,
} from './wechat-bridge.js';

const BOT_TEST_TIMEOUT_MS = 10_000;

/**
 * PR1197 review (P1-4): Feishu and Lark share one Maka channel but live on
 * different open-platform hosts. Brand-switch by the persisted channel domain,
 * mirroring the onboarding flow, so a Lark tenant is not probed against the
 * feishu.cn host.
 */
export function feishuOpenApiHost(domain: string | undefined): string {
  return domain?.trim() === 'larksuite.com' ? 'open.larksuite.com' : 'open.feishu.cn';
}

export async function testBotChannel(
  provider: BotProvider,
  channel: BotChannelSettings,
): Promise<BotTestResult> {
  if (
    provider !== 'feishu' &&
    provider !== 'wecom' &&
    provider !== 'wechat' &&
    provider !== 'dingtalk' &&
    provider !== 'qq' &&
    provider !== 'slack' &&
    !channel.token.trim()
  ) {
    return { ok: false, error: 'Bot token is required' };
  }
  switch (provider) {
    case 'telegram':
      return testTelegram(channel);
    case 'discord':
      return testDiscord(channel);
    case 'feishu':
      return testFeishu(channel);
    case 'wecom':
      return testWeCom(channel);
    case 'dingtalk':
      return testDingTalk(channel);
    case 'wechat':
      return testWechat(channel);
    case 'qq':
      return testQQ(channel);
    case 'slack':
      return testSlack(channel);
  }
}

async function testSlack(channel: BotChannelSettings): Promise<BotTestResult> {
  const botToken = channel.token.trim();
  const appToken = channel.appSecret?.trim() ?? '';
  if (!botToken || !appToken) {
    return { ok: false, error: 'Slack 需要 Bot Token 与 App-Level Token' };
  }
  try {
    const identity = await new WebClient(botToken).auth.test();
    if (!identity.ok) return { ok: false, error: identity.error ?? 'Slack auth.test failed' };
    const socket = await new WebClient(appToken).apps.connections.open();
    if (!socket.ok || !socket.url) {
      return { ok: false, error: socket.error ?? 'Slack Socket Mode connection failed' };
    }
    return {
      ok: true,
      identity: {
        id: identity.user_id ?? identity.bot_id ?? identity.team_id ?? 'slack',
        ...(identity.user ? { username: identity.user, displayName: identity.user } : {}),
      },
      capabilities: { auth: true, socketMode: true },
      hint: '凭据有效，Socket Mode 连接可用。',
    };
  } catch (error) {
    return { ok: false, error: generalizedErrorMessage(error) };
  }
}

async function testWechat(channel: BotChannelSettings): Promise<BotTestResult> {
  if (channel.token.trim() && normalizeWechatIlinkBaseUrl(channel.webhookUrl)) {
    return testWechatIlinkCredentials(channel);
  }
  const appId = channel.appId?.trim() ?? '';
  const appSecret = channel.appSecret?.trim() || channel.token.trim();
  if (!appId || !appSecret) {
    return testWechatBridge(channel);
  }
  try {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const response = await proxiedFetch(url.toString(), {
      method: 'GET',
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || typeof json.access_token !== 'string') {
      return { ok: false, error: json.errmsg ?? `HTTP ${response.status}` };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
      hint: '凭据有效；消息收发还需要公众号服务器配置和回调验证。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testTelegram(channel: BotChannelSettings): Promise<BotTestResult> {
  const base = `https://api.telegram.org/bot${channel.token}`;
  try {
    const me = await (
      await proxiedFetch(`${base}/getMe`, { method: 'GET', timeoutMs: BOT_TEST_TIMEOUT_MS })
    ).json();
    if (!me.ok) return { ok: false, error: me.description ?? 'Invalid bot token' };
    return {
      ok: true,
      identity: {
        id: String(me.result.id),
        username: me.result.username,
        displayName: me.result.first_name,
      },
      messageSent: false,
      hint: '发送 /start 给机器人后可在运行态接收消息。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testDiscord(channel: BotChannelSettings): Promise<BotTestResult> {
  try {
    const response = await proxiedFetch('https://discord.com/api/v10/users/@me', {
      method: 'GET',
      headers: { Authorization: `Bot ${channel.token}` },
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: json.message ?? `HTTP ${response.status}` };
    return {
      ok: true,
      identity: { id: json.id, username: json.username, displayName: json.global_name },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR1197 review (P1-4): WeCom onboarding + the live bridge now use the
 * enterprise-WeChat **AI bot** credentials, stored as:
 *   - `appId` = AI 应用 Bot ID
 *   - `appSecret` = AI 应用 Secret
 *
 * The previous probe issued a corp `gettoken` (corp_id + corp_secret), which is
 * a DIFFERENT credential shape. Running it against valid AI-bot credentials
 * fails with an errcode, and the settings layer would then persist
 * `connected: false` over a channel whose credentials are actually good —
 * breaking a working channel with a wrong-endpoint test.
 *
 * The `@wecom/aibot-node-sdk` verifies credentials only through its WebSocket
 * auth handshake (`WSAuthFailureError`); there is no cheap REST endpoint to
 * validate a botId/secret pair without opening a live connection. So this probe
 * validates shape/non-empty only and marks the result `verified: false`. The
 * live bridge status (surfaced via readiness) remains the authority on whether
 * the connection is actually up; the settings layer must not downgrade it on
 * the strength of this unverified check.
 */
async function testWeCom(channel: BotChannelSettings): Promise<BotTestResult> {
  const botId = channel.appId?.trim() ?? '';
  const secret = channel.appSecret?.trim() ?? '';
  if (!botId || !secret) {
    return { ok: false, error: '企业微信 AI 机器人需要 Bot ID 与 Secret', verified: false };
  }
  return {
    ok: true,
    verified: false,
    identity: { id: botId, username: botId, displayName: botId },
    capabilities: { auth: false },
    hint: '已保存凭据；企业微信 AI 机器人的连接状态以运行态长连接为准。',
  };
}

/**
 * PR-BOT-DINGTALK-CREDENTIALS-TEST-0 (external bot research: enterprise IM
 * adapters): verify DingTalk (钉钉) self-built app credentials by
 * issuing an `access_token` via the open-platform `gettoken` endpoint.
 * Mirrors the WeCom pattern almost exactly — the open platform exposes
 * the same handshake shape with `appkey` / `appsecret`.
 *
 * Storage semantics (matches WeCom + Feishu):
 *   - `appId` = appkey (the self-built app's identifier)
 *   - `appSecret` = appsecret (the self-built app's secret)
 *
 * Success only proves the credentials exist; it does NOT prove that
 * message send / receive will work — that needs DingTalk's outgoing
 * group webhook or the Stream interface, which lands separately.
 */
async function testDingTalk(channel: BotChannelSettings): Promise<BotTestResult> {
  const appkey = channel.appId?.trim() ?? '';
  const appsecret = channel.appSecret?.trim() ?? '';
  if (!appkey || !appsecret) {
    return { ok: false, error: '钉钉需要 appkey 与 appsecret' };
  }
  const url =
    'https://oapi.dingtalk.com/gettoken?appkey=' +
    encodeURIComponent(appkey) +
    '&appsecret=' +
    encodeURIComponent(appsecret);
  try {
    const response = await proxiedFetch(url, {
      method: 'GET',
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (json.errcode && json.errcode !== 0) {
      return {
        ok: false,
        error: json.errmsg ? `钉钉: ${json.errmsg}` : `钉钉 errcode ${json.errcode}`,
      };
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return { ok: false, error: '钉钉凭据测试未返回 access_token' };
    }
    return {
      ok: true,
      identity: { id: appkey, username: appkey, displayName: appkey },
      capabilities: { auth: true },
      hint: '凭据有效；接收消息需要 outgoing 机器人或 Stream 模式配置。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR-BOT-QQ-CREDENTIALS-TEST-0 (external bot research: official QQ Channel
 * bot): verify QQ 官方机器人 self-built app credentials by issuing an
 * `access_token` via the bots open-platform endpoint. Same handshake
 * shape as WeCom / DingTalk — `appId` + `clientSecret`, returns a
 * short-lived bot access token.
 *
 * Storage semantics (matches the existing self-built app pattern):
 *   - `appId` = QQ Bot App ID
 *   - `appSecret` = QQ Bot Client Secret
 *
 * Success only proves the credentials exist; it does NOT prove that
 * the bot can receive events (that needs WebSocket Gateway connection)
 * or send messages (that needs channel context + per-channel API).
 */
async function testQQ(channel: BotChannelSettings): Promise<BotTestResult> {
  const appId = channel.appId?.trim() ?? '';
  const clientSecret = channel.appSecret?.trim() ?? '';
  if (!appId || !clientSecret) {
    return { ok: false, error: 'QQ 官方机器人需要 App ID 与 Client Secret' };
  }
  try {
    const response = await proxiedFetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof json.message === 'string' && json.message.length > 0
          ? `QQ: ${json.message}`
          : `HTTP ${response.status}`;
      return { ok: false, error: message };
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return { ok: false, error: 'QQ 官方机器人凭据测试未返回 access_token' };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
      hint: '凭据有效；接收消息需要 QQ Gateway WebSocket 接入。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testFeishu(channel: BotChannelSettings): Promise<BotTestResult> {
  const appId = channel.appId ?? '';
  const appSecret = channel.appSecret || channel.token;
  if (!appId || !appSecret) return { ok: false, error: 'Feishu appId and appSecret are required' };
  // PR1197 review (P1-4): brand-switch the account host by the channel domain,
  // exactly like the onboarding flow does. A Lark tenant (larksuite.com) cannot
  // issue a tenant_access_token from the feishu.cn host, so a hardcoded host
  // wrongly fails a valid Lark channel.
  const host = feishuOpenApiHost(channel.domain);
  try {
    const response = await proxiedFetch(
      `https://${host}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        timeoutMs: BOT_TEST_TIMEOUT_MS,
      },
    );
    const json = await response.json();
    if (json.code !== 0 || !json.tenant_access_token) {
      return { ok: false, error: json.msg ?? 'Failed to issue tenant_access_token' };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
