/**
 * PR-BOT-QQ-OPERATIONAL-0 (external bot research: QQ 官方机器人 Gateway):
 * full QQ Channel Bot lifecycle — access_token cache, Gateway WebSocket
 * connect, identify, heartbeat, AT_MESSAGE_CREATE / DIRECT_MESSAGE_CREATE
 * / GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE dispatch, REST send via
 * /v2/groups/{id}/messages and /v2/users/{id}/messages, reconnect with
 * backoff.
 *
 * QQ Bot Gateway protocol is the same shape as Discord (op codes 0/1/2/
 * 7/9/10/11, identify+heartbeat lifecycle); only the auth scheme + dispatch
 * event names differ. Auth uses `QQBot <access_token>` (the app access
 * token from getAppAccessToken), refreshed before expiry.
 */

import { WebSocket } from 'undici';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import { proxiedFetch } from './proxied-fetch.js';
import type { BotPlatform, BotSendOptions, BotStatus, SendCapable } from './types.js';

const QQ_API = 'https://api.sgroup.qq.com';
const QQ_BOT_TOKEN = 'https://bots.qq.com/app/getAppAccessToken';

// PUBLIC_GUILD_MESSAGES | DIRECT_MESSAGE | GUILDS — sufficient for
// receive of @-mentions in guild channels + DMs.
// 1 (GUILDS) | 4096 (DIRECT_MESSAGE) | 1<<30 (PUBLIC_GUILD_MESSAGES).
const QQ_INTENT_GUILDS = 1 << 0;
const QQ_INTENT_DIRECT_MESSAGE = 1 << 12;
const QQ_INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;
const QQ_INTENT_PUBLIC_MESSAGES = 1 << 25;
const QQ_INTENTS =
  QQ_INTENT_GUILDS |
  QQ_INTENT_DIRECT_MESSAGE |
  QQ_INTENT_PUBLIC_GUILD_MESSAGES |
  QQ_INTENT_PUBLIC_MESSAGES;

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000;
const RECONNECT_DELAY_MIN_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
const SEND_RETRY_DELAY_MIN_MS = 1_000;
const SEND_RETRY_DELAY_MAX_MS = 30_000;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// QQ uses these dispatch event types for message arrival.
const QQ_EVENT_AT_MESSAGE = 'AT_MESSAGE_CREATE';
const QQ_EVENT_DIRECT_MESSAGE = 'DIRECT_MESSAGE_CREATE';
const QQ_EVENT_GROUP_AT_MESSAGE = 'GROUP_AT_MESSAGE_CREATE';
const QQ_EVENT_C2C_MESSAGE = 'C2C_MESSAGE_CREATE';

interface QQReadyPayload {
  session_id: string;
  user: { id: string; username?: string };
}

// QQ guild message (channel @-mention): { id, channel_id, content, author }
interface QQChannelMessagePayload {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: { id: string; username?: string; bot?: boolean };
}

// QQ group message: { id, group_openid, content, author: { id, member_openid } }
interface QQGroupMessagePayload {
  id: string;
  group_openid: string;
  content?: string;
  author?: { id?: string; member_openid?: string; user_openid?: string };
}

// QQ C2C (1-on-1) message: { id, content, author: { user_openid } }
interface QQC2CMessagePayload {
  id: string;
  content?: string;
  author?: { user_openid?: string; id?: string };
}

export type QQCloseDecision =
  | { kind: 'stopped' }
  | { kind: 'fatal'; code: number }
  | { kind: 'reconnect'; resumable: boolean };

const QQ_FATAL_CLOSE_CODES = new Set<number>([
  4004, // authentication failed
  4014, // disallowed intent
]);

export function decideQQClose(code: number, explicitlyStopped: boolean): QQCloseDecision {
  if (explicitlyStopped) return { kind: 'stopped' };
  if (QQ_FATAL_CLOSE_CODES.has(code)) return { kind: 'fatal', code };
  const resumable = code !== 1000 && code !== 1001;
  return { kind: 'reconnect', resumable };
}

function qqReconnectBackoffMs(attempts: number): number {
  const exp = Math.min(2 ** attempts, RECONNECT_DELAY_MAX_MS / RECONNECT_DELAY_MIN_MS);
  return Math.min(RECONNECT_DELAY_MIN_MS * exp, RECONNECT_DELAY_MAX_MS);
}

/**
 * Pure helper: classify a QQ HTTP send response. QQ's open-platform
 * error scheme uses `code` in the JSON body for non-200s. 429 is
 * the retry signal.
 */
export type QQSendClassification =
  | { kind: 'ok'; messageId: string | null }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fatal'; description: string };

export function classifyQQSendResponse(status: number, bodyJson: unknown): QQSendClassification {
  if (status >= 200 && status < 300) {
    const id =
      (bodyJson as { id?: unknown; msg_id?: unknown } | null)?.id ??
      (bodyJson as { msg_id?: unknown } | null)?.msg_id;
    return {
      kind: 'ok',
      messageId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    };
  }
  if (status === 429) {
    return {
      kind: 'retry',
      delayMs: Math.min(Math.max(SEND_RETRY_DELAY_MIN_MS, 1_000), SEND_RETRY_DELAY_MAX_MS),
    };
  }
  const body = bodyJson as { message?: unknown; code?: unknown } | null;
  const description =
    (typeof body?.message === 'string' && body.message) ||
    (typeof body?.code === 'number' ? `code ${body.code}` : `HTTP ${status}`);
  return { kind: 'fatal', description };
}

/**
 * Pure helper: map a QQ channel AT message dispatch to BotMessageEvent.
 */
export function qqChannelMessageToEvent(
  d: QQChannelMessagePayload,
  receivedAt: number,
): {
  platform: 'qq';
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
} | null {
  if (!d?.author || d.author.bot === true) return null;
  const userId = String(d.author.id);
  return {
    platform: 'qq',
    userId,
    userName: d.author.username ?? userId,
    chatId: `channel:${d.channel_id}`,
    isGroup: true,
    text: typeof d.content === 'string' ? d.content : '',
    sourceMessageId: String(d.id),
    receivedAt,
  };
}

export function qqGroupMessageToEvent(
  d: QQGroupMessagePayload,
  receivedAt: number,
): {
  platform: 'qq';
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
} | null {
  if (!d?.group_openid) return null;
  const userId = d.author?.member_openid ?? d.author?.user_openid ?? d.author?.id ?? '';
  if (!userId) return null;
  return {
    platform: 'qq',
    userId: String(userId),
    userName: String(userId),
    chatId: `group:${d.group_openid}`,
    isGroup: true,
    text: typeof d.content === 'string' ? d.content : '',
    sourceMessageId: String(d.id),
    receivedAt,
  };
}

export function qqC2CMessageToEvent(
  d: QQC2CMessagePayload,
  receivedAt: number,
): {
  platform: 'qq';
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
} | null {
  const userId = d.author?.user_openid ?? d.author?.id ?? '';
  if (!userId) return null;
  return {
    platform: 'qq',
    userId: String(userId),
    userName: String(userId),
    chatId: `c2c:${userId}`,
    isGroup: false,
    text: typeof d.content === 'string' ? d.content : '',
    sourceMessageId: String(d.id),
    receivedAt,
  };
}

/**
 * Pure helper: route a send to the right QQ REST endpoint based on the
 * chatId prefix that the receive-side helpers stamp.
 */
export function pickQQSendRoute(
  chatId: string,
  text: string,
  options?: BotSendOptions,
): {
  path: string;
  body: Record<string, unknown>;
} | null {
  const replyId = options?.replyToMessageId;
  if (chatId.startsWith('channel:')) {
    const targetId = chatId.slice('channel:'.length).trim();
    if (!targetId) return null;
    return {
      path: `/channels/${targetId}/messages`,
      body: {
        content: text,
        msg_type: 0,
        ...(replyId ? { msg_id: replyId } : {}),
      },
    };
  }
  if (chatId.startsWith('group:')) {
    const targetId = chatId.slice('group:'.length).trim();
    if (!targetId) return null;
    return {
      path: `/v2/groups/${targetId}/messages`,
      body: {
        content: text,
        msg_type: 0,
        ...(replyId ? { msg_id: replyId } : {}),
      },
    };
  }
  if (chatId.startsWith('c2c:')) {
    const targetId = chatId.slice('c2c:'.length).trim();
    if (!targetId) return null;
    return {
      path: `/v2/users/${targetId}/messages`,
      body: {
        content: text,
        msg_type: 0,
        ...(replyId ? { msg_id: replyId } : {}),
      },
    };
  }
  return null;
}

export function pickQQTypingRoute(chatId: string): string | null {
  if (!chatId.startsWith('channel:')) return null;
  const channelId = chatId.slice('channel:'.length).trim();
  if (!channelId) return null;
  return `/channels/${channelId}/typing`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class QQBotBridge extends BaseBotAdapter implements SendCapable {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval = 41_250;
  private heartbeatAcked = true;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private token: CachedToken | null = null;
  private explicitlyStopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(platform: BotPlatform, settings: BotChannelSettings) {
    super(platform, settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    if (!this.settings.appId?.trim() || !this.settings.appSecret?.trim()) {
      this.reason = 'no-credentials';
      this.readiness = 'scaffolded';
      return;
    }
    this.explicitlyStopped = false;
    await this.startGateway();
  }

  async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.running = false;
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* swallow */
      }
      this.ws = null;
    }
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    if (this.platform !== 'qq' || !this.running) return null;
    const route = pickQQSendRoute(chatId, text, options);
    if (!route) return null;
    const token = await this.refreshTokenIfNeeded();
    if (!token) return null;
    const first = await this.performSend(route.path, route.body, token);
    let classification = first;
    if (first.kind === 'retry') {
      await sleep(first.delayMs);
      classification = await this.performSend(route.path, route.body, token);
    }
    if (classification.kind !== 'ok') {
      this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
      this.reason = classification.kind === 'retry' ? 'rate-limited' : classification.description;
      this.emitStatusChange();
      return null;
    }
    this.readiness = 'operational';
    this.reason = undefined;
    this.lastEventAt = Date.now();
    this.emitStatusChange();
    return classification.messageId;
  }

  /**
   * PR-BOT-QQ-TYPING-INDICATOR-0: parity with Telegram + Discord.
   * QQ Channel Bot exposes POST `/channels/{channel_id}/typing` for
   * guild channel messages only — Groups and C2C use a different
   * messaging stack with no typing endpoint. We gate on the `channel:`
   * chatId prefix so an unsupported target silently degrades to
   * `false` rather than emitting a confusing 404.
   */
  async sendTypingIndicator(chatId: string): Promise<boolean> {
    if (this.platform !== 'qq' || !this.running) return false;
    const route = pickQQTypingRoute(chatId);
    if (!route) return false;
    const token = await this.refreshTokenIfNeeded();
    if (!token) return false;
    try {
      const response = await proxiedFetch(`${QQ_API}${route}`, {
        method: 'POST',
        headers: { Authorization: `QQBot ${token}` },
        timeoutMs: 5_000,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }

  private async performSend(
    path: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<QQSendClassification> {
    try {
      const response = await proxiedFetch(`${QQ_API}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      });
      const json = await response.json().catch(() => null);
      return classifyQQSendResponse(response.status, json);
    } catch (error) {
      return { kind: 'fatal', description: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refreshTokenIfNeeded(): Promise<string | null> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return this.token.value;
    }
    const appId = this.settings.appId?.trim() ?? '';
    const clientSecret = this.settings.appSecret?.trim() ?? '';
    if (!appId || !clientSecret) return null;
    try {
      const response = await proxiedFetch(QQ_BOT_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
        timeoutMs: 10_000,
      });
      const json = (await response.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;
      if (!response.ok || typeof json?.access_token !== 'string') {
        this.reason = `getAppAccessToken-${response.status}`;
        return null;
      }
      const expiresInSecRaw = (json as { expires_in?: unknown }).expires_in;
      const expiresInSec =
        typeof expiresInSecRaw === 'number'
          ? expiresInSecRaw
          : typeof expiresInSecRaw === 'string'
            ? Number.parseInt(expiresInSecRaw, 10) || 7200
            : 7200;
      this.token = { value: json.access_token, expiresAt: now + expiresInSec * 1_000 };
      return this.token.value;
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private async startGateway(): Promise<void> {
    const token = await this.refreshTokenIfNeeded();
    if (!token) {
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
      return;
    }
    try {
      const response = await proxiedFetch(`${QQ_API}/gateway/bot`, {
        method: 'GET',
        headers: { Authorization: `QQBot ${token}` },
        timeoutMs: 10_000,
      });
      const json = (await response.json().catch(() => null)) as { url?: unknown } | null;
      if (!response.ok || !json || typeof json.url !== 'string') {
        this.reason = `gateway-bot-${response.status}`;
        this.readiness = 'configured';
        this.emitStatusChange();
        this.scheduleReconnect();
        return;
      }
      this.connect(json.url);
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
    }
  }

  private connect(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.running = true;
      this.startedAt = Date.now();
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      const data = event.data;
      this.handlePayload(typeof data === 'string' ? data : String(data));
    });
    ws.addEventListener('close', (event: { code: number; reason: string }) => {
      this.handleClose(event.code, event.reason);
    });
    ws.addEventListener('error', () => {
      // The close event fires immediately after; no separate handling.
    });
  }

  private handlePayload(data: string): void {
    let payload: { op?: number; s?: number | null; t?: string; d?: unknown };
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof payload.s === 'number') this.seq = payload.s;
    switch (payload.op) {
      case OP_HELLO:
        this.onHello(payload.d as { heartbeat_interval: number });
        break;
      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case OP_DISPATCH:
        this.onDispatch(payload.t ?? '', payload.d);
        break;
      case OP_HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP_RECONNECT:
        this.forceReconnect(true);
        break;
      case OP_INVALID_SESSION:
        this.forceReconnect(payload.d === true);
        break;
    }
  }

  private onHello(d: { heartbeat_interval: number }): void {
    this.heartbeatInterval = d.heartbeat_interval;
    this.heartbeatAcked = true;
    this.scheduleHeartbeat(Math.random() * d.heartbeat_interval);
    if (this.sessionId && this.seq !== null) {
      this.sendResume();
    } else {
      void this.sendIdentify();
    }
  }

  private async sendIdentify(): Promise<void> {
    const token = await this.refreshTokenIfNeeded();
    if (!token) return;
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: QQ_INTENTS,
        shard: [0, 1],
        properties: { $os: 'linux', $browser: 'maka', $device: 'maka' },
      },
    });
  }

  private async sendResume(): Promise<void> {
    const token = await this.refreshTokenIfNeeded();
    if (!token) return;
    this.send({
      op: OP_RESUME,
      d: {
        token: `QQBot ${token}`,
        session_id: this.sessionId,
        seq: this.seq,
      },
    });
  }

  private sendHeartbeat(): void {
    if (!this.ws) return;
    if (!this.heartbeatAcked) {
      this.forceReconnect(true);
      return;
    }
    this.heartbeatAcked = false;
    this.send({ op: OP_HEARTBEAT, d: this.seq });
  }

  private scheduleHeartbeat(initialDelay: number): void {
    this.clearHeartbeat();
    const initial = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatInterval);
      this.heartbeatTimer.unref?.();
    }, initialDelay);
    initial.unref?.();
  }

  private onDispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      const ready = d as QQReadyPayload;
      this.sessionId = ready.session_id;
      this.identity = {
        id: String(ready.user.id),
        username: ready.user.username,
        displayName: ready.user.username,
      };
      this.readiness = 'operational';
      this.reason = undefined;
      this.reconnectAttempts = 0;
      this.emitStatusChange();
      return;
    }
    if (type === 'RESUMED') {
      this.readiness = 'operational';
      this.reason = undefined;
      this.reconnectAttempts = 0;
      this.emitStatusChange();
      return;
    }
    const receivedAt = Date.now();
    let event: ReturnType<typeof qqChannelMessageToEvent> = null;
    if (type === QQ_EVENT_AT_MESSAGE) {
      event = qqChannelMessageToEvent(d as QQChannelMessagePayload, receivedAt);
    } else if (type === QQ_EVENT_DIRECT_MESSAGE) {
      // DMs use the channel-message shape.
      const channelLike = qqChannelMessageToEvent(d as QQChannelMessagePayload, receivedAt);
      if (channelLike) {
        event = { ...channelLike, isGroup: false, chatId: `dm:${channelLike.chatId}` };
      }
    } else if (type === QQ_EVENT_GROUP_AT_MESSAGE) {
      event = qqGroupMessageToEvent(d as QQGroupMessagePayload, receivedAt);
    } else if (type === QQ_EVENT_C2C_MESSAGE) {
      event = qqC2CMessageToEvent(d as QQC2CMessagePayload, receivedAt);
    }
    if (!event) return;
    this.lastEventAt = event.receivedAt;
    this.emitIncomingMessage(event);
    this.emitStatusChange();
  }

  private send(payload: object): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // Swallow — close handler will fire if the socket died.
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleClose(code: number, reason: string): void {
    this.clearHeartbeat();
    this.ws = null;
    this.running = false;
    const decision = decideQQClose(code, this.explicitlyStopped);
    if (decision.kind === 'stopped') return;
    if (decision.kind === 'fatal') {
      this.readiness = 'configured';
      this.reason = `gateway-closed-${code}`;
      this.sessionId = null;
      this.seq = null;
      this.emitStatusChange();
      return;
    }
    if (!decision.resumable) {
      this.sessionId = null;
      this.seq = null;
    }
    this.readiness = 'degraded';
    this.reason = reason || `gateway-closed-${code}`;
    this.emitStatusChange();
    this.scheduleReconnect();
  }

  private forceReconnect(resumable: boolean): void {
    if (!resumable) {
      this.sessionId = null;
      this.seq = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* swallow */
      }
      this.ws = null;
    }
    this.clearHeartbeat();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.explicitlyStopped) return;
    this.clearReconnect();
    const delay = qqReconnectBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startGateway();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

export const __TEST__ = {
  decideQQClose,
  classifyQQSendResponse,
  qqChannelMessageToEvent,
  qqGroupMessageToEvent,
  qqC2CMessageToEvent,
  pickQQSendRoute,
  pickQQTypingRoute,
};
