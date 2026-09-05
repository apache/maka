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
 * PR-BOT-DISCORD-OPERATIONAL-0 (external bot research: Discord Gateway):
 * full Discord bot lifecycle — gateway WebSocket, identify, heartbeat,
 * MESSAGE_CREATE dispatch, REST send, reply threading, typing
 * indicator, reconnect with backoff. Exposes the same bridge surface
 * as the other platforms so the registry can swap it in without other
 * code changes.
 *
 * Out of scope: voice, slash commands, sharding (Maka bots target
 * small servers; one shard is plenty under the Discord
 * recommended-shard threshold).
 *
 * Gateway plumbing (opcodes, heartbeat, identify/resume, reconnect)
 * lives in GatewayBridgeBase; this class supplies only Discord's auth
 * scheme, identify/resume payloads, dispatch event names, and REST
 * send routes.
 */

import { GatewayBridgeBase } from './gateway-bridge-base.js';
import { proxiedFetch } from './proxied-fetch.js';
import type { BotSendOptions, SendCapable } from './types.js';
import type { WsCloseDecision } from './ws-bridge-base.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_VERSION = 10;

// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
// MESSAGE_CONTENT is a privileged intent — for unverified bots (<100
// servers) it can be enabled in the Discord Developer Portal; for
// verified bots it requires Discord approval. The gateway will close
// with code 4014 if the intent is requested but not enabled — we
// surface that as `disallowed-intent` rather than retry forever.
const DISCORD_INTENT_GUILD_MESSAGES = 1 << 9;
const DISCORD_INTENT_DIRECT_MESSAGES = 1 << 12;
const DISCORD_INTENT_MESSAGE_CONTENT = 1 << 15;
const DISCORD_INTENTS =
  DISCORD_INTENT_GUILD_MESSAGES | DISCORD_INTENT_DIRECT_MESSAGES | DISCORD_INTENT_MESSAGE_CONTENT;

const SEND_RETRY_DELAY_MIN_MS = 1_000;
const SEND_RETRY_DELAY_MAX_MS = 30_000;

// Close codes we never auto-recover from.
const FATAL_CLOSE_CODES = new Set<number>([
  4004, // authentication failed
  4010, // invalid shard
  4011, // sharding required
  4012, // invalid api version
  4013, // invalid intent
  4014, // disallowed intent
]);

interface DiscordReadyPayload {
  session_id: string;
  resume_gateway_url: string;
  user: { id: string; username: string; global_name?: string };
}

interface DiscordMessagePayload {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: { id: string; username?: string; global_name?: string; bot?: boolean };
}

/**
 * Pure decision: given the gateway close code and whether the bridge
 * was explicitly stopped, decide what to do next. Extracted so the
 * branching can be tested without mocking a WebSocket.
 */
export type DiscordCloseDecision =
  | { kind: 'stopped' }
  | { kind: 'fatal'; code: number }
  | { kind: 'reconnect'; resumable: boolean };

export function decideDiscordClose(code: number, explicitlyStopped: boolean): DiscordCloseDecision {
  if (explicitlyStopped) return { kind: 'stopped' };
  if (FATAL_CLOSE_CODES.has(code)) return { kind: 'fatal', code };
  // 4000-4003, 4005-4009 are recoverable per Discord docs; treat
  // anything not in the fatal set as resumable to maximize uptime.
  const resumable = code !== 1000 && code !== 1001;
  return { kind: 'reconnect', resumable };
}

/**
 * Pure helper: build a Discord message-create request body. Reply
 * threading via `message_reference` (Discord's native reply UX);
 * `fail_if_not_exists: false` so a deleted parent does not 400 the
 * send.
 */
export function buildDiscordSendBody(
  text: string,
  options: BotSendOptions | undefined,
  chunkIndex: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = { content: text };
  const replyToMessageId = normalizeDiscordReplyToMessageId(options?.replyToMessageId);
  if (chunkIndex === 0 && replyToMessageId !== undefined) {
    body.message_reference = {
      message_id: replyToMessageId,
      fail_if_not_exists: false,
    };
  }
  return body;
}

function normalizeDiscordReplyToMessageId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizeDiscordChannelId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Pure helper: classify a Discord HTTP send response so the caller
 * can route between done / retry / fatal. Discord's 429 returns a
 * `retry_after` (seconds) field; non-429 4xx are caller errors and
 * we don't retry them.
 */
export type DiscordSendClassification =
  | { kind: 'ok'; messageId: string | null }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fatal'; description: string };

export function classifyDiscordSendResponse(
  status: number,
  bodyJson: unknown,
): DiscordSendClassification {
  if (status >= 200 && status < 300) {
    const id = (bodyJson as { id?: unknown } | null)?.id;
    return {
      kind: 'ok',
      messageId: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
    };
  }
  if (status === 429) {
    const raw = (bodyJson as { retry_after?: unknown } | null)?.retry_after;
    const seconds = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
    const ms = seconds * 1000;
    return {
      kind: 'retry',
      delayMs: Math.min(Math.max(ms, SEND_RETRY_DELAY_MIN_MS), SEND_RETRY_DELAY_MAX_MS),
    };
  }
  const message = (bodyJson as { message?: unknown } | null)?.message;
  return {
    kind: 'fatal',
    description: typeof message === 'string' && message.length > 0 ? message : `HTTP ${status}`,
  };
}

/**
 * Pure helper: map a Discord MESSAGE_CREATE payload to the runtime's
 * neutral BotMessageEvent shape. Returns `null` for messages the bot
 * should silently ignore (its own messages, other bot messages,
 * webhook system messages with no author).
 */
export function discordMessageToEvent(
  d: DiscordMessagePayload,
  receivedAt: number,
): {
  platform: 'discord';
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
    platform: 'discord',
    userId,
    userName: d.author.global_name ?? d.author.username ?? userId,
    chatId: String(d.channel_id),
    // Discord guilds are "groups" semantically — DMs are channels
    // without a guild_id. The bot platform's conversation-key
    // contract treats `isGroup === true` as "do not honor plaintext
    // reset", which matches the policy we want for Discord guilds.
    isGroup: typeof d.guild_id === 'string' && d.guild_id.length > 0,
    text: typeof d.content === 'string' ? d.content : '',
    sourceMessageId: String(d.id ?? ''),
    receivedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DiscordBotBridge extends GatewayBridgeBase implements SendCapable {
  protected resumeGatewayUrl: string | null = null;

  protected override checkCredentials(): string | null {
    return this.settings.token.trim() ? null : 'no-token';
  }

  protected override decideClose(code: number, explicitlyStopped: boolean): WsCloseDecision {
    return decideDiscordClose(code, explicitlyStopped);
  }

  /**
   * Discord's resume_gateway_url is only valid while the session it
   * belongs to is alive — never route a fresh identify to it.
   */
  protected override resetSession(): void {
    super.resetSession();
    this.resumeGatewayUrl = null;
  }

  protected override async fetchGatewayUrl(): Promise<string | null> {
    try {
      const response = await proxiedFetch(`${DISCORD_API}/gateway/bot`, {
        method: 'GET',
        headers: { Authorization: `Bot ${this.settings.token}` },
        timeoutMs: 10_000,
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || !json || typeof json.url !== 'string') {
        const message = (json as { message?: unknown } | null)?.message;
        this.reason = typeof message === 'string' ? message : `gateway-bot-${response.status}`;
        this.readiness = 'configured';
        this.emitStatusChange();
        // Usually a transient outage — openConnection schedules the retry.
        return null;
      }
      const gatewayUrl = this.resumeGatewayUrl ?? json.url;
      return `${gatewayUrl}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`;
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      return null;
    }
  }

  protected override buildIdentifyPayload(): Record<string, unknown> {
    return {
      token: this.settings.token,
      intents: DISCORD_INTENTS,
      properties: { os: 'linux', browser: 'maka', device: 'maka' },
    };
  }

  protected override buildResumePayload(): Record<string, unknown> {
    return {
      token: this.settings.token,
      session_id: this.sessionId,
      seq: this.seq,
    };
  }

  protected override onDispatch(type: string, d: unknown): void {
    if (type === 'READY') {
      const ready = d as DiscordReadyPayload;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url;
      this.identity = {
        id: String(ready.user.id),
        username: ready.user.username,
        displayName: ready.user.global_name ?? ready.user.username,
      };
      this.promoteToOperational();
      return;
    }
    if (type === 'RESUMED') {
      this.promoteToOperational();
      return;
    }
    if (type === 'MESSAGE_CREATE') {
      const event = discordMessageToEvent(d as DiscordMessagePayload, Date.now());
      if (!event) return;
      this.lastEventAt = event.receivedAt;
      this.emitIncomingMessage(event);
      this.emitStatusChange();
      return;
    }
  }

  /**
   * Discord's REST send. UTF-8 cap is 2000 chars for regular
   * messages; we split client-side. Reply threading via
   * `message_reference`. 429 retry once with the API-provided
   * `retry_after`.
   */
  async sendMessage(
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    if (this.platform !== 'discord' || !this.running) return null;
    const channelId = normalizeDiscordChannelId(chatId);
    if (!channelId) return null;
    const chunks = splitDiscordContent(text);
    let lastMessageId: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const body = buildDiscordSendBody(chunks[i], options, i);
      const first = await this.performSend(channelId, body);
      let classification = first;
      if (first.kind === 'retry') {
        await sleep(first.delayMs);
        classification = await this.performSend(channelId, body);
      }
      if (classification.kind !== 'ok') {
        this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
        this.reason = classification.kind === 'retry' ? 'rate-limited' : classification.description;
        this.emitStatusChange();
        return null;
      }
      lastMessageId = classification.messageId ?? lastMessageId;
    }
    this.readiness = 'operational';
    this.reason = undefined;
    this.lastEventAt = Date.now();
    this.emitStatusChange();
    return lastMessageId;
  }

  async sendTypingIndicator(chatId: string): Promise<boolean> {
    if (this.platform !== 'discord' || !this.running) return false;
    const channelId = normalizeDiscordChannelId(chatId);
    if (!channelId) return false;
    try {
      const response = await proxiedFetch(`${DISCORD_API}/channels/${channelId}/typing`, {
        method: 'POST',
        headers: { Authorization: `Bot ${this.settings.token}` },
        timeoutMs: 5_000,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async performSend(
    chatId: string,
    body: Record<string, unknown>,
  ): Promise<DiscordSendClassification> {
    try {
      const response = await proxiedFetch(`${DISCORD_API}/channels/${chatId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.settings.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      });
      const json = await response.json().catch(() => null);
      return classifyDiscordSendResponse(response.status, json);
    } catch (error) {
      return { kind: 'fatal', description: error instanceof Error ? error.message : String(error) };
    }
  }
}

const DISCORD_MAX_CONTENT = 2000;

/**
 * Split text into Discord's per-message character limit. Discord
 * measures content in code points; we approximate with JS string
 * `length` which is UTF-16 code units. For pure ASCII or BMP this is
 * identical; for emoji-heavy text we end up slightly conservative
 * (slicing earlier than necessary) — that's a safer side to err on.
 */
export function splitDiscordContent(text: string): string[] {
  if (text.length <= DISCORD_MAX_CONTENT) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_MAX_CONTENT) {
    out.push(remaining.slice(0, DISCORD_MAX_CONTENT));
    remaining = remaining.slice(DISCORD_MAX_CONTENT);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

export const __TEST__ = {
  decideDiscordClose,
  buildDiscordSendBody,
  normalizeDiscordReplyToMessageId,
  normalizeDiscordChannelId,
  classifyDiscordSendResponse,
  discordMessageToEvent,
  splitDiscordContent,
};
