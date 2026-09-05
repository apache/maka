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

import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import { proxiedFetch } from './proxied-fetch.js';
import type {
  BotIncomingMessage,
  BotSendOptions,
  BotStatus,
  BotTestResult,
  SendCapable,
} from './types.js';

const DEFAULT_WECHAT_BRIDGE_URL = 'http://127.0.0.1:18400';
const WECHAT_BRIDGE_TIMEOUT_MS = 5_000;
const WECHAT_ILINK_TIMEOUT_MS = 15_000;
const WECHAT_BRIDGE_QR_PATHS = ['/api/weixin/qrcode', '/qrcode'];
const WECHAT_ILINK_BASE_INFO = { channel_version: '0.1.0' } as const;
const require = createRequire(import.meta.url);

const LOCAL_WECHAT_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function normalizeWechatBridgeUrl(input: string | undefined): string | null {
  const raw = input?.trim() || DEFAULT_WECHAT_BRIDGE_URL;
  if (raw.length > 256) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return null;
    if (!LOCAL_WECHAT_BRIDGE_HOSTS.has(url.hostname)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function normalizeWechatIlinkBaseUrl(input: string | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  if (raw.length > 256) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'ilinkai.weixin.qq.com') return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function normalizeWechatSendTarget(value: string): string | null {
  const target = value.trim();
  return target.length > 0 ? target : null;
}

export class WechatBridge extends BaseBotAdapter implements SendCapable {
  private abortController: AbortController | null = null;

  constructor(settings: BotChannelSettings) {
    super('wechat', settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    const probe = isWechatIlinkChannel(this.settings)
      ? await testWechatIlinkCredentials(this.settings)
      : await testWechatBridge(this.settings);
    if (!probe.ok) {
      this.running = false;
      this.reason = probe.error;
      this.readiness = botReadinessFromSettings(this.settings);
      this.emitStatusChange();
      return;
    }
    this.identity = probe.identity;
    this.running = true;
    this.startedAt = Date.now();
    this.reason = undefined;
    this.readiness = 'credentials_valid';
    this.emitStatusChange();
    // Fire-and-forget streaming loops. Both methods own their own
    // try/catch around the inner request loop, but a synchronous
    // throw during setup (e.g. AbortController constructor failing
    // in a constrained Node runtime) would otherwise surface as an
    // UnhandledPromiseRejection. The `.catch` keeps the bridge
    // marked degraded instead of crashing the main process.
    const fail = (err: unknown) => {
      this.running = false;
      this.reason = err instanceof Error ? err.message : 'stream-failed';
      this.readiness = 'degraded';
      this.emitStatusChange();
    };
    if (isWechatIlinkChannel(this.settings)) {
      void this.streamIlinkMessages('').catch(fail);
    } else {
      void this.streamLiveMessages(Math.floor(Date.now() / 1000)).catch(fail);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: BotSendOptions,
  ): Promise<string | null> {
    if (!this.running) return null;
    const targetId = normalizeWechatSendTarget(chatId);
    if (!targetId) return null;
    try {
      if (isWechatIlinkChannel(this.settings)) {
        return await this.sendIlinkMessage(targetId, text);
      }
      const response = await wechatBridgeJson(this.settings, '/send', {
        method: 'POST',
        body: JSON.stringify({ wxid: targetId, text }),
      });
      const status = typeof response.status === 'string' ? response.status : '';
      if (status === 'failed') {
        this.readiness = 'degraded';
        this.reason =
          typeof response.diagnostic === 'string' ? response.diagnostic : 'wechat-send-failed';
        this.emitStatusChange();
        return null;
      }
      this.readiness = 'operational';
      this.reason = undefined;
      this.lastEventAt = Date.now();
      this.emitStatusChange();
      const id = response.messageId ?? response.id ?? response.svrId ?? status;
      return typeof id === 'string' || typeof id === 'number' ? String(id) : 'wechat-submitted';
    } catch (error) {
      this.readiness = 'degraded';
      this.reason = generalizedErrorMessage(error);
      this.emitStatusChange();
      return null;
    }
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }

  private async streamLiveMessages(sinceEpochSeconds: number): Promise<void> {
    const baseUrl = normalizeWechatBridgeUrl(this.settings.webhookUrl);
    if (!baseUrl) return;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const response = await proxiedFetch(
          `${baseUrl}/messages/stream?since=${sinceEpochSeconds}`,
          {
            method: 'GET',
            headers: wechatBridgeHeaders(this.settings),
            signal: this.abortController.signal,
            timeoutMs: 0,
          },
        );
        if (!response.ok || !response.body)
          throw new Error(`WeChat stream HTTP ${response.status}`);
        for await (const raw of readSseJsonObjects(response.body)) {
          const messages = Array.isArray(raw) ? raw : [raw];
          for (const message of messages) {
            const event = mapWechatBridgeMessage(message);
            if (!event) continue;
            sinceEpochSeconds = Math.max(sinceEpochSeconds, Math.floor(event.receivedAt / 1000));
            this.readiness = 'operational';
            this.reason = undefined;
            this.emitIncomingMessage(event);
            this.emitStatusChange();
          }
        }
        if (this.running) await sleep(1_000);
      } catch (error) {
        if (!this.running) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        this.readiness =
          this.readiness === 'operational' ? 'degraded' : botReadinessFromSettings(this.settings);
        this.reason = generalizedErrorMessage(error);
        this.emitStatusChange();
        await sleep(3_000);
      }
    }
  }

  private async streamIlinkMessages(cursor: string): Promise<void> {
    const baseUrl = normalizeWechatIlinkBaseUrl(this.settings.webhookUrl);
    const token = this.settings.token.trim();
    if (!baseUrl || !token) return;
    let consecutiveErrors = 0;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const response = await wechatIlinkPost(
          baseUrl,
          '/ilink/bot/getupdates',
          {
            get_updates_buf: cursor,
            base_info: WECHAT_ILINK_BASE_INFO,
          },
          token,
          this.abortController.signal,
        );
        consecutiveErrors = 0;
        const errcode = typeof response.errcode === 'number' ? response.errcode : 0;
        if (errcode === -14) continue;
        if (errcode !== 0) {
          this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
          this.reason = stringField(response.errmsg) ?? `ilink-${errcode}`;
          this.emitStatusChange();
          await sleep(5_000);
          continue;
        }
        const nextCursor = stringField(response.get_updates_buf);
        if (nextCursor) cursor = nextCursor;
        const messages = Array.isArray(response.msgs) ? response.msgs : [];
        for (const message of messages) {
          const event = mapWechatIlinkMessage(message);
          if (!event) continue;
          this.readiness = 'operational';
          this.reason = undefined;
          this.lastEventAt = Date.now();
          this.emitIncomingMessage(event);
          this.emitStatusChange();
        }
        if (this.running && messages.length === 0) await sleep(800);
      } catch (error) {
        if (!this.running) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        consecutiveErrors += 1;
        this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
        this.reason = generalizedErrorMessage(error);
        this.emitStatusChange();
        await sleep(consecutiveErrors >= 3 ? 30_000 : 2_000);
        if (consecutiveErrors >= 3) consecutiveErrors = 0;
      }
    }
  }

  private async sendIlinkMessage(chatId: string, text: string): Promise<string | null> {
    const baseUrl = normalizeWechatIlinkBaseUrl(this.settings.webhookUrl);
    const token = this.settings.token.trim();
    if (!baseUrl || !token) return null;
    const clientId = randomUUID();
    await wechatIlinkPost(
      baseUrl,
      '/ilink/bot/sendmessage',
      {
        msg: {
          to_user_id: chatId,
          from_user_id: '',
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: '',
          item_list: [{ type: 1, text_item: { text: stripMarkdownForWechat(text) } }],
        },
        base_info: WECHAT_ILINK_BASE_INFO,
      },
      token,
    );
    this.readiness = 'operational';
    this.reason = undefined;
    this.lastEventAt = Date.now();
    this.emitStatusChange();
    return clientId;
  }
}

export type WechatBridgeQrCodeResult =
  | {
      ok: true;
      qrcode: string | null;
      expired: boolean;
      loggedIn: boolean;
      diagnostic?: string;
    }
  | {
      ok: false;
      error: string;
      hint: string;
    };

export async function getWechatBridgeQrCode(
  channel: BotChannelSettings,
): Promise<WechatBridgeQrCodeResult> {
  const baseUrl = normalizeWechatBridgeUrl(channel.webhookUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: 'WeChat bridge URL must be http://127.0.0.1 or http://localhost',
      hint: '微信扫码登录只允许访问本机 wechat-bridge，不能指向远端 URL。',
    };
  }

  let lastError: unknown;
  for (const path of WECHAT_BRIDGE_QR_PATHS) {
    try {
      const payload = await wechatBridgeJson(channel, path, { method: 'GET' });
      return await normalizeWechatQrPayload(payload);
    } catch (error) {
      lastError = error;
      if (!isNotFoundLikeError(error)) break;
    }
  }

  return {
    ok: false,
    error: generalizedErrorMessage(lastError),
    hint: '先启动本机 wechat-bridge，并确认它暴露了 iLink 兼容的 /api/weixin/qrcode 或 /qrcode 接口。',
  };
}

export function mapWechatBridgeMessage(raw: unknown): BotIncomingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  if (message.fromSelf === true || message.isSelf === true) return null;
  const chatId = firstStringField(message, ['chatId', 'roomId', 'toWxid', 'talker']);
  const isGroup =
    message.isGroup === true || message.is_group === true || chatId?.endsWith('@chatroom') === true;
  const isMentioned =
    message.isMentioned === true || message.isAt === true || message.atMe === true;
  if (isGroup && !isMentioned) return null;
  const senderId = firstStringField(message, ['senderId', 'fromWxid', 'sender', 'wxid']) ?? chatId;
  const messageId = firstStringField(message, ['messageId', 'msgId', 'id', 'svrId']);
  if (!chatId || !senderId || !messageId) return null;
  const body = firstStringField(message, ['body', 'text', 'content', 'message']) ?? '';
  const attachmentKind = wechatAttachmentKind(message);
  if (!body && !attachmentKind) return null;
  const timestamp = firstNumberField(message, ['timestamp', 'createTime', 'createdAt']);
  return {
    platform: 'wechat',
    userId: senderId,
    userName: firstStringField(message, ['senderName', 'nickname', 'displayName']) ?? senderId,
    chatId,
    isGroup,
    text: body,
    sourceMessageId: messageId,
    receivedAt: timestamp ? normalizeBridgeTimestamp(timestamp) : Date.now(),
    ...(attachmentKind ? { attachmentKind } : {}),
  };
}

export function mapWechatIlinkMessage(raw: unknown): BotIncomingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  const itemList = Array.isArray(message.item_list) ? message.item_list : [];
  const textParts: string[] = [];
  let hasMedia = false;
  for (const item of itemList) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === 'number' ? entry.type : undefined;
    if (type === 1 && entry.text_item && typeof entry.text_item === 'object') {
      const text = stringField((entry.text_item as Record<string, unknown>).text);
      if (text) textParts.push(text);
    } else if (type === 3 && entry.voice_item && typeof entry.voice_item === 'object') {
      const text = stringField((entry.voice_item as Record<string, unknown>).text);
      if (text) textParts.push(text);
      else hasMedia = true;
    } else if (type === 2 || type === 4 || type === 5) {
      hasMedia = true;
    }
  }
  const text = textParts.join('\n').trim();
  if (!text && !hasMedia) return null;
  const userId = firstStringField(message, ['from_user_id', 'fromUserId', 'fromWxid']);
  if (!userId) return null;
  const messageId =
    firstStringField(message, ['msg_id', 'message_id', 'client_id', 'id']) ?? randomUUID();
  const timestamp = firstNumberField(message, ['create_time', 'timestamp', 'createdAt']);
  return {
    platform: 'wechat',
    userId,
    userName: firstStringField(message, ['from_user_name', 'nickname', 'displayName']) ?? userId,
    chatId: userId,
    isGroup: false,
    text,
    sourceMessageId: messageId,
    receivedAt: timestamp ? normalizeBridgeTimestamp(timestamp) : Date.now(),
    ...(hasMedia ? { attachmentKind: 'unknown' as const } : {}),
  };
}

export async function* readSseJsonObjects(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (data) yield JSON.parse(data);
      boundary = findSseBoundary(buffer);
    }
  }
}

export async function testWechatBridge(channel: BotChannelSettings): Promise<BotTestResult> {
  const baseUrl = normalizeWechatBridgeUrl(channel.webhookUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: 'WeChat bridge URL must be http://127.0.0.1 or http://localhost',
      hint: '微信本地桥接只允许访问本机 wechat-bridge，不能指向远端 URL。',
    };
  }
  try {
    const health = await wechatBridgeJson(channel, '/health', { method: 'GET' });
    const self =
      typeof health.self === 'object' && health.self !== null
        ? (health.self as Record<string, unknown>)
        : {};
    const sendStatus =
      typeof health.send_status === 'string'
        ? health.send_status
        : typeof health.sendStatus === 'string'
          ? health.sendStatus
          : undefined;
    return {
      ok: true,
      identity: {
        id: stringField(health.wxid) ?? stringField(self.wxid) ?? baseUrl,
        username: stringField(health.alias) ?? stringField(self.alias),
        displayName: stringField(health.nickname) ?? stringField(self.nickname) ?? 'wechat-bridge',
      },
      capabilities: {
        health: true,
        send: sendStatus !== 'unavailable' && sendStatus !== 'blocked',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: generalizedErrorMessage(error),
      hint: '先在本机启动 wechat-bridge，并确认 WeChat 已登录；发送能力需要 wxp_act_ 激活码。',
    };
  }
}

async function wechatBridgeJson(
  channel: BotChannelSettings,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeWechatBridgeUrl(channel.webhookUrl);
  if (!baseUrl) throw new Error('Invalid WeChat bridge URL');
  const headers = wechatBridgeHeaders(channel);
  if (init.body) headers['Content-Type'] = 'application/json';
  const response = await proxiedFetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body,
    timeoutMs: WECHAT_BRIDGE_TIMEOUT_MS,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      stringField(json.error) ?? stringField(json.message) ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

export async function testWechatIlinkCredentials(
  channel: BotChannelSettings,
): Promise<BotTestResult> {
  const baseUrl = normalizeWechatIlinkBaseUrl(channel.webhookUrl);
  const token = channel.token.trim();
  if (!baseUrl || !token) {
    return {
      ok: false,
      error: 'WeChat iLink credentials are incomplete',
      hint: '请先完成微信扫码登录，保存 iLink bot token 与 base URL。',
    };
  }
  return {
    ok: true,
    identity: {
      id: channel.botUserId ?? baseUrl,
      username: channel.botUserId,
      displayName: channel.botUserId ? `iLink ${channel.botUserId}` : 'WeChat iLink',
    },
    capabilities: { auth: true, send: true },
    hint: '扫码登录凭据已保存；运行态会通过 iLink 长轮询接收消息。',
  };
}

function isWechatIlinkChannel(channel: BotChannelSettings): boolean {
  return Boolean(channel.token.trim() && normalizeWechatIlinkBaseUrl(channel.webhookUrl));
}

async function wechatIlinkPost(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await proxiedFetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      AuthorizationType: 'ilink_bot_token',
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUinHeader(),
    },
    body: JSON.stringify(body),
    signal,
    timeoutMs: path.includes('getupdates') ? 0 : WECHAT_ILINK_TIMEOUT_MS,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function randomWechatUinHeader(): string {
  return Buffer.from(String(randomBytes(4).readUInt32LE(0)), 'utf8').toString('base64');
}

async function normalizeWechatQrPayload(
  payload: Record<string, unknown>,
): Promise<WechatBridgeQrCodeResult> {
  const loggedIn = payload.loggedIn === true || payload.logged_in === true;
  const expired = payload.expired === true || payload.status === 'expired';
  const rawQr =
    stringField(payload.qrcode) ??
    stringField(payload.qrCode) ??
    stringField(payload.qrcode_img_content) ??
    stringField(payload.qrUrl) ??
    null;

  return {
    ok: true,
    qrcode: rawQr ? await renderWechatQrCode(rawQr) : null,
    expired,
    loggedIn,
    diagnostic: stringField(payload.diagnostic) ?? stringField(payload.message),
  };
}

function stripMarkdownForWechat(input: string): string {
  return input
    .replace(/^```[a-zA-Z]*\s*$/gm, '')
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function renderWechatQrCode(raw: string): Promise<string> {
  if (raw.startsWith('data:image/')) return raw;
  if (looksLikeBase64Png(raw)) return `data:image/png;base64,${raw}`;
  const qrcode = require('qrcode') as {
    toDataURL(input: string, options: Record<string, unknown>): Promise<string>;
  };
  return qrcode.toDataURL(raw, {
    width: 256,
    margin: 1,
    errorCorrectionLevel: 'M',
  });
}

function looksLikeBase64Png(value: string): boolean {
  return value.length > 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isNotFoundLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('HTTP 404') ||
    /Cannot\s+(GET|POST)/i.test(message) ||
    /not found/i.test(message)
  );
}

function wechatBridgeHeaders(channel: BotChannelSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const bearer = channel.token.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstStringField(message: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(message[key]);
    if (value) return value;
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumberField(message: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberField(message[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeBridgeTimestamp(timestamp: number): number {
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000;
}

function wechatAttachmentKind(
  message: Record<string, unknown>,
): BotIncomingMessage['attachmentKind'] | undefined {
  const kind = firstStringField(message, ['messageKind', 'mediaType', 'type']);
  switch (kind) {
    case 'image':
      return 'photo';
    case 'audio':
      return 'audio';
    case 'voice':
      return 'voice';
    case 'video':
      return 'video';
    case 'file':
    case 'attachment':
      return 'document';
    case 'emoticon':
      return 'sticker';
    default:
      return message.hasMedia === true ? 'unknown' : undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSseBoundary(input: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(input);
  return match ? { index: match.index, length: match[0].length } : null;
}
