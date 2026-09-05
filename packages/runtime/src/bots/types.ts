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

import type { BotProvider, BotReadinessState } from '@maka/core/bot-chat-settings';
import type { BotMessageEvent, BotPlatform } from '@maka/core/bot-events';
import type { GeneralizedErrorClass } from '@maka/core/redaction';

export type { BotPlatform };

export type BotStatusCode =
  | BotTestErrorCode
  | GeneralizedErrorClass
  | 'disabled'
  | 'stopped'
  | 'no-token'
  | 'no-credentials'
  | 'missing-feishu-credentials'
  | 'missing-slack-tokens'
  | 'slack-disconnected'
  | 'disconnected'
  | 'reconnecting'
  | 'rate-limited'
  | 'polling-timeout'
  | 'send-failed'
  | 'get-me-failed'
  | 'stream-failed';

export type BotStatusReason =
  | BotStatusCode
  | `gateway-bot-${number}`
  | `gateway-closed-${number}`
  | `connections-open-${number}`
  | `stream-closed-${number}`
  | `send-failed-${number}`
  | `getAppAccessToken-${number}`;

export interface BotStatus {
  platform: BotPlatform;
  /**
   * Runtime process/polling loop state only. This is not operational
   * readiness; use `readiness` for user-facing health.
   */
  running: boolean;
  readiness: BotReadinessState;
  reason?: string;
  startedAt?: number;
  lastEventAt?: number;
  connection: 'polling' | 'gateway' | 'webhook' | 'none';
  identity?: {
    id?: string;
    username?: string;
    displayName?: string;
  };
}

export type BotIncomingMessage = BotMessageEvent;

export interface BotBridge {
  readonly platform: BotPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStatus(): BotStatus;
}

/**
 * PR-BOT-REPLY-TO-MESSAGE-0 (external bot research): bot replies should
 * thread under the originating user message so a Telegram group with
 * concurrent conversations does not visually scramble. `replyToMessageId`
 * is the platform-native message id of the message being replied to.
 * Implementations must tolerate a missing/deleted parent (e.g. Telegram
 * uses `allow_sending_without_reply: true`).
 *
 * Only the first chunk of a multi-chunk send is threaded; continuation
 * chunks render as ordinary sequential messages so the receiver sees a
 * single threaded head followed by the continuation, not N forks under
 * the same parent.
 */
export interface BotSendOptions {
  readonly replyToMessageId?: string;
  /**
   * PR-BOT-EPHEMERAL-REPLY-0 (external bot research): when set, the bridge
   * schedules a delete-message call N milliseconds after the send
   * completes. Use for transient system notices (reset ack / help
   * reply / "无法处理" fallback) that should not accumulate in the chat.
   *
   * The actual agent reply must NOT use this — auto-deleting the
   * useful answer would defeat the bot's purpose.
   *
   * Clamped to a 48-hour window in the bridge; Telegram does not let
   * bots delete their own DMs past that, so a longer schedule would
   * silently no-op.
   */
  readonly ephemeralTtlMs?: number;
}

export interface BotReplyStreamOptions extends BotSendOptions {
  /** Whether the reply target is a group/channel rather than a direct chat. */
  readonly isGroup: boolean;
  /** Stable identity of the Runtime Host Turn being projected. */
  readonly streamId: string;
}

/**
 * Best-effort progressive delivery for one agent reply.
 *
 * `update` receives the latest complete text snapshot, not an append-only
 * chunk. `finish` persists the authoritative final text through the channel's
 * normal message path. Implementations must serialize their own network work;
 * callers never await `update` while draining Runtime Host events.
 */
export interface BotReplyStream {
  update(text: string): void;
  finish(finalText: string): Promise<string | null>;
  abort(): Promise<void>;
}

export interface SendCapable {
  sendMessage(chatId: string, text: string, options?: BotSendOptions): Promise<string | null>;
  startReplyStream?(chatId: string, options: BotReplyStreamOptions): BotReplyStream | null;
  /**
   * PR-BOT-TYPING-INDICATOR-0 (external bot research): post a one-shot
   * presence/typing signal. Telegram auto-clears it after ~5 seconds;
   * callers wanting sustained indication must call again periodically.
   * Returns `true` if the signal was delivered, `false` on any failure
   * (including unsupported platforms — drops silently rather than throw).
   */
  sendTypingIndicator?(chatId: string): Promise<boolean>;
}

/** Stable machine codes for producer-known test failures; presenters own copy. */
export type BotTestErrorCode =
  | 'connection_failed'
  | 'token_missing'
  | 'token_invalid'
  | 'slack_tokens_missing'
  | 'feishu_credentials_missing'
  | 'wecom_credentials_missing'
  | 'dingtalk_credentials_missing'
  | 'dingtalk_no_access_token'
  | 'qq_credentials_missing'
  | 'qq_no_access_token'
  | 'wechat_bridge_url_invalid'
  | 'wechat_ilink_credentials_incomplete';

/** Stable machine codes for follow-up guidance; presenters own copy. */
export type BotTestHintCode =
  | 'slack_socket_ready'
  | 'wechat_mp_callback_required'
  | 'telegram_send_start'
  | 'wecom_runtime_authority'
  | 'dingtalk_stream_required'
  | 'qq_gateway_required'
  | 'wechat_bridge_local_only'
  | 'wechat_bridge_start_required'
  | 'wechat_ilink_login_required'
  | 'wechat_ilink_polling';

export interface BotTestResult {
  ok: boolean;
  identity?: { id: string; username?: string; displayName?: string };
  messageSent?: boolean;
  capabilities?: Record<string, boolean>;
  errorCode?: BotTestErrorCode;
  /** Diagnostic for redacted logging only, never product copy. */
  error?: string;
  hintCode?: BotTestHintCode;
  /**
   * `false` when `ok` reflects only a shape/non-empty check and the credentials
   * could NOT be verified against a live endpoint (e.g. WeCom AI-bot creds,
   * which the SDK only validates through a WebSocket auth handshake). Callers
   * that persist connection state must NOT downgrade a working channel on the
   * strength of an unverified probe. Absent/`true` means the result came from a
   * real credential probe.
   */
  verified?: boolean;
}
