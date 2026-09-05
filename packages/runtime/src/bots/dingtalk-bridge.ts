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

/**
 * PR-BOT-DINGTALK-OPERATIONAL-0 (external bot research: DingTalk Stream):
 * full DingTalk (钉钉) bot lifecycle — access_token cache, Stream
 * subscription open, WebSocket connect, frame dispatch + ack, bot
 * message receive, REST send via the open-platform messaging API,
 * reconnect with backoff.
 *
 * Stream is DingTalk's outbound-connection alternative to the legacy
 * callback URL. The bot opens a WebSocket to DingTalk; events arrive
 * inbound. No need to expose a public HTTP port — Maka can run as a
 * desktop app without a tunnel.
 *
 * DingTalk's Stream protocol is NOT Discord/QQ-shaped (no opcodes,
 * heartbeat, identify/resume — frames carry headers/messageId/topic
 * and every delivery must be acked), so this class extends
 * WsBridgeBase directly: only the WS transport lifecycle (connect,
 * close policy, reconnect with backoff, stop) is shared with the
 * gateway bridges.
 *
 * Storage semantics (matches the credential-test PR):
 *   - `appId` = appKey (the self-built app's identifier)
 *   - `appSecret` = appsecret
 * Outbound replies require the open-platform `robotCode`; we derive it
 * from `appKey` (DingTalk's chatbot SDK uses appKey as robotCode).
 */

import { proxiedFetch } from './proxied-fetch.js';
import type { BotSendOptions, SendCapable } from './types.js';
import { WsBridgeBase, type WsCloseDecision } from './ws-bridge-base.js';

const DINGTALK_API = 'https://api.dingtalk.com';
const DINGTALK_OAPI = 'https://oapi.dingtalk.com';

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000; // refresh 5 min before expiry
const SEND_RETRY_DELAY_MIN_MS = 1_000;
const SEND_RETRY_DELAY_MAX_MS = 30_000;

const DINGTALK_TOPIC_BOT_MESSAGES = '/v1.0/im/bot/messages/get';

interface DingTalkConnectionOpenResponse {
  endpoint: string;
  ticket: string;
}

interface DingTalkStreamFrame {
  specVersion?: string;
  type?: 'SYSTEM' | 'EVENT' | 'CALLBACK';
  headers?: { messageId?: string; topic?: string; contentType?: string };
  data?: string;
}

interface DingTalkBotMessagePayload {
  senderId?: string;
  senderNick?: string;
  conversationId?: string;
  conversationType?: '1' | '2'; // 1 = single chat, 2 = group
  text?: { content?: string };
  robotCode?: string;
  chatbotUserId?: string;
}

/**
 * Pure decision: given the gateway close code and whether the bridge
 * was explicitly stopped, decide what to do next. Extracted so the
 * branching is unit-testable without a live WebSocket.
 */
export type DingTalkCloseDecision = { kind: 'stopped' } | { kind: 'reconnect' };

export function decideDingTalkClose(
  _code: number,
  explicitlyStopped: boolean,
): DingTalkCloseDecision {
  if (explicitlyStopped) return { kind: 'stopped' };
  return { kind: 'reconnect' };
}

/**
 * Pure helper: build the open-platform bot reply request body.
 * For group chats we POST to `/v1.0/robot/groupMessages/send` and the
 * body needs `openConversationId` + `robotCode`. For single chats
 * we use `/v1.0/robot/oToMessages/batchSend` with `userIds`. The
 * caller decides which endpoint based on conversation context; this
 * helper just shape-checks the body.
 */
export function buildDingTalkGroupSendBody(
  openConversationId: string,
  robotCode: string,
  text: string,
): Record<string, unknown> {
  return {
    robotCode,
    openConversationId,
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: text }),
  };
}

export function buildDingTalkSingleSendBody(
  userId: string,
  robotCode: string,
  text: string,
): Record<string, unknown> {
  return {
    robotCode,
    userIds: [userId],
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: text }),
  };
}

export function pickDingTalkSendRoute(
  chatId: string,
  robotCode: string,
  text: string,
): {
  path: string;
  body: Record<string, unknown>;
} | null {
  const targetId = chatId.trim();
  if (!targetId) return null;
  const isGroup = targetId.startsWith('cid');
  return {
    path: isGroup ? '/v1.0/robot/groupMessages/send' : '/v1.0/robot/oToMessages/batchSend',
    body: isGroup
      ? buildDingTalkGroupSendBody(targetId, robotCode, text)
      : buildDingTalkSingleSendBody(targetId, robotCode, text),
  };
}

/**
 * Pure helper: classify DingTalk's HTTP send response so we can route
 * between done / retry / fatal. DingTalk uses `errcode` style (0 = ok)
 * with HTTP wrapping. 429 is the retry signal.
 */
export type DingTalkSendClassification =
  | { kind: 'ok'; messageId: string | null }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fatal'; description: string };

export function classifyDingTalkSendResponse(
  status: number,
  bodyJson: unknown,
): DingTalkSendClassification {
  if (status >= 200 && status < 300) {
    const body = bodyJson as {
      errcode?: number;
      errmsg?: string;
      processQueryKey?: unknown;
    } | null;
    if (body && typeof body.errcode === 'number' && body.errcode !== 0) {
      return { kind: 'fatal', description: body.errmsg ?? `errcode ${body.errcode}` };
    }
    const id = body?.processQueryKey;
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
  const message = bodyJson as { errmsg?: unknown; message?: unknown } | null;
  const description =
    (typeof message?.errmsg === 'string' && message.errmsg) ||
    (typeof message?.message === 'string' && message.message) ||
    `HTTP ${status}`;
  return { kind: 'fatal', description };
}

/**
 * Pure helper: map a DingTalk Stream `/v1.0/im/bot/messages/get`
 * callback payload to BotMessageEvent. Returns `null` for payloads
 * that aren't text messages we can act on.
 */
export function dingTalkPayloadToEvent(
  payload: DingTalkBotMessagePayload,
  receivedAt: number,
): {
  platform: 'dingtalk';
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const content = payload.text?.content;
  if (typeof content !== 'string' || content.length === 0) return null;
  const chatId = payload.conversationId;
  const userId = payload.senderId;
  if (typeof chatId !== 'string' || chatId.length === 0) return null;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  return {
    platform: 'dingtalk',
    userId,
    userName: payload.senderNick ?? userId,
    chatId,
    isGroup: payload.conversationType === '2',
    text: content,
    // DingTalk Stream callbacks do not carry the original message id;
    // use a synthetic key so downstream contracts that key off
    // `sourceMessageId` still get a unique value.
    sourceMessageId: `${chatId}:${receivedAt}`,
    receivedAt,
  };
}

/**
 * Pure helper: shape the ack frame DingTalk Stream expects after every
 * CALLBACK delivery. Missing the ack causes the gateway to retransmit.
 */
export function buildDingTalkAckFrame(
  messageId: string,
  data: Record<string, unknown> = {},
): {
  code: number;
  headers: { contentType: string; messageId: string };
  data: string;
} {
  return {
    code: 200,
    headers: { contentType: 'application/json', messageId },
    data: JSON.stringify(data),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class DingTalkBotBridge extends WsBridgeBase implements SendCapable {
  private token: CachedToken | null = null;

  protected override readonly closeReasonPrefix = 'stream';

  protected override checkCredentials(): string | null {
    return this.settings.appId?.trim() && this.settings.appSecret?.trim() ? null : 'no-credentials';
  }

  protected override decideClose(code: number, explicitlyStopped: boolean): WsCloseDecision {
    const decision = decideDingTalkClose(code, explicitlyStopped);
    return decision.kind === 'stopped' ? decision : { kind: 'reconnect', resumable: true };
  }

  protected override onWsOpen(): void {
    super.onWsOpen();
    // DingTalk's Stream has no READY dispatch — connections/open
    // accepting the subscription IS the operational signal.
    this.readiness = 'operational';
    this.reason = undefined;
    this.reconnectAttempts = 0;
    this.emitStatusChange();
  }

  protected override async openConnection(): Promise<void> {
    const token = await this.refreshTokenIfNeeded();
    if (!token) {
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
      return;
    }
    try {
      const response = await proxiedFetch(`${DINGTALK_API}/v1.0/gateway/connections/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({
          clientId: this.settings.appId?.trim(),
          clientSecret: this.settings.appSecret?.trim(),
          subscriptions: [
            { type: 'EVENT', topic: '*' },
            { type: 'CALLBACK', topic: DINGTALK_TOPIC_BOT_MESSAGES },
          ],
          ua: 'Maka/0.1',
          localIp: '127.0.0.1',
        }),
        timeoutMs: 10_000,
      });
      const json = (await response
        .json()
        .catch(() => null)) as DingTalkConnectionOpenResponse | null;
      if (
        !response.ok ||
        !json ||
        typeof json.endpoint !== 'string' ||
        typeof json.ticket !== 'string'
      ) {
        this.reason = `connections-open-${response.status}`;
        this.readiness = 'configured';
        this.emitStatusChange();
        this.scheduleReconnect();
        return;
      }
      this.connect(`${json.endpoint}?ticket=${encodeURIComponent(json.ticket)}`);
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      this.scheduleReconnect();
    }
  }

  protected override handleWsMessage(raw: string): void {
    let frame: DingTalkStreamFrame;
    try {
      frame = JSON.parse(raw) as DingTalkStreamFrame;
    } catch {
      return;
    }
    const messageId = frame.headers?.messageId;
    if (!messageId) return;
    if (frame.type === 'CALLBACK' && frame.headers?.topic === DINGTALK_TOPIC_BOT_MESSAGES) {
      let payload: DingTalkBotMessagePayload | null = null;
      try {
        payload =
          typeof frame.data === 'string'
            ? (JSON.parse(frame.data) as DingTalkBotMessagePayload)
            : null;
      } catch {
        payload = null;
      }
      if (payload) {
        const event = dingTalkPayloadToEvent(payload, Date.now());
        if (event) {
          this.lastEventAt = event.receivedAt;
          this.emitIncomingMessage(event);
          this.emitStatusChange();
        }
      }
      this.sendAck(messageId);
      return;
    }
    // System / unrelated event types — still ack so the gateway does
    // not redeliver, but do not emit a message event.
    this.sendAck(messageId);
  }

  private sendAck(messageId: string): void {
    this.sendWs(buildDingTalkAckFrame(messageId));
  }

  /**
   * DingTalk REST send. We treat any chatId with a `cidp` prefix as a
   * group conversation; pure-numeric or other prefixes route to the
   * single-user batch API. The caller (main.ts) already knows whether
   * the bot conversation is a group via the BotMessageEvent.isGroup
   * flag, but the bridge's `sendMessage` only sees the chatId — so we
   * make a conservative split based on the `conversationType` hint
   * baked into the chatId structure: group conversation IDs start with
   * `cid` per DingTalk's open platform docs.
   */
  async sendMessage(
    chatId: string,
    text: string,
    _options?: BotSendOptions,
  ): Promise<string | null> {
    if (this.platform !== 'dingtalk' || !this.running) return null;
    const robotCode = this.settings.appId?.trim() ?? '';
    const route = pickDingTalkSendRoute(chatId, robotCode, text);
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

  private async performSend(
    path: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<DingTalkSendClassification> {
    try {
      const response = await proxiedFetch(`${DINGTALK_API}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      });
      const json = await response.json().catch(() => null);
      return classifyDingTalkSendResponse(response.status, json);
    } catch (error) {
      return { kind: 'fatal', description: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refreshTokenIfNeeded(): Promise<string | null> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_SKEW_MS > now) {
      return this.token.value;
    }
    const appkey = this.settings.appId?.trim() ?? '';
    const appsecret = this.settings.appSecret?.trim() ?? '';
    if (!appkey || !appsecret) return null;
    try {
      const url =
        `${DINGTALK_OAPI}/gettoken?appkey=` +
        encodeURIComponent(appkey) +
        '&appsecret=' +
        encodeURIComponent(appsecret);
      const response = await proxiedFetch(url, { method: 'GET', timeoutMs: 10_000 });
      const json = (await response.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
        errcode?: number;
        errmsg?: string;
      } | null;
      if (!json || (json.errcode !== undefined && json.errcode !== 0)) {
        this.reason = json?.errmsg ?? 'gettoken failed';
        return null;
      }
      if (typeof json.access_token !== 'string') return null;
      const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 7200;
      this.token = {
        value: json.access_token,
        expiresAt: now + expiresInSec * 1_000,
      };
      return this.token.value;
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      return null;
    }
  }
}

export const __TEST__ = {
  decideDingTalkClose,
  buildDingTalkGroupSendBody,
  buildDingTalkSingleSendBody,
  pickDingTalkSendRoute,
  classifyDingTalkSendResponse,
  dingTalkPayloadToEvent,
  buildDingTalkAckFrame,
};
