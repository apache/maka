/**
 * PR-BOT-DISCORD-OPERATIONAL-0 (external bot research: Discord Gateway):
 * full Discord bot lifecycle — gateway WebSocket, identify, heartbeat,
 * MESSAGE_CREATE dispatch, REST send, reply threading, typing
 * indicator, reconnect with backoff. Mirrors the SimpleBotBridge
 * surface so the registry can swap it in without other code changes.
 *
 * Out of scope: voice, slash commands, sharding (Maka bots target
 * small servers; one shard is plenty under the Discord
 * recommended-shard threshold).
 */

import { WebSocket } from 'undici';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import { proxiedFetch } from './proxied-fetch.js';
import type { BotPlatform, BotSendOptions, BotStatus, SendCapable } from './types.js';

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

const RECONNECT_DELAY_MIN_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 30_000;
const SEND_RETRY_DELAY_MIN_MS = 1_000;
const SEND_RETRY_DELAY_MAX_MS = 30_000;

// Discord gateway opcodes.
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

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
 * Pure helper: compute the next backoff delay given the attempt count.
 * Exponential up to RECONNECT_DELAY_MAX_MS.
 */
function reconnectBackoffMs(attempts: number): number {
  const exp = Math.min(2 ** attempts, RECONNECT_DELAY_MAX_MS / RECONNECT_DELAY_MIN_MS);
  return Math.min(RECONNECT_DELAY_MIN_MS * exp, RECONNECT_DELAY_MAX_MS);
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

export class DiscordBotBridge extends BaseBotAdapter implements SendCapable {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval = 41_250;
  private heartbeatAcked = true;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
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
    if (!this.settings.token.trim()) {
      this.reason = 'no-token';
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

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
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

  private async startGateway(): Promise<void> {
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
        // Schedule a retry — this is usually a transient outage.
        this.scheduleReconnect();
        return;
      }
      const gatewayUrl = this.resumeGatewayUrl ?? json.url;
      this.connect(`${gatewayUrl}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`);
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
      // Gateway is up; readiness will be promoted to operational
      // once READY arrives.
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      const data = event.data;
      this.handlePayload(typeof data === 'string' ? data : String(data));
    });
    ws.addEventListener('close', (event: { code: number; reason: string }) => {
      this.handleClose(event.code, event.reason);
    });
    ws.addEventListener('error', () => {
      // The `close` event fires immediately after; no separate handling.
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
    // Jitter the initial heartbeat per Discord recommendation so a
    // fleet of bots does not synchronize their pings.
    this.scheduleHeartbeat(Math.random() * d.heartbeat_interval);
    if (this.sessionId && this.seq !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendIdentify(): void {
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.settings.token,
        intents: DISCORD_INTENTS,
        properties: { os: 'linux', browser: 'maka', device: 'maka' },
      },
    });
  }

  private sendResume(): void {
    this.send({
      op: OP_RESUME,
      d: {
        token: this.settings.token,
        session_id: this.sessionId,
        seq: this.seq,
      },
    });
  }

  private sendHeartbeat(): void {
    if (!this.ws) return;
    if (!this.heartbeatAcked) {
      // Missed ack — Discord docs say reconnect immediately.
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
      const ready = d as DiscordReadyPayload;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url;
      this.identity = {
        id: String(ready.user.id),
        username: ready.user.username,
        displayName: ready.user.global_name ?? ready.user.username,
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
    if (type === 'MESSAGE_CREATE') {
      const event = discordMessageToEvent(d as DiscordMessagePayload, Date.now());
      if (!event) return;
      this.lastEventAt = event.receivedAt;
      this.emitIncomingMessage(event);
      this.emitStatusChange();
      return;
    }
  }

  private send(payload: object): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // Swallow — the close handler will fire if the socket died.
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
    const decision = decideDiscordClose(code, this.explicitlyStopped);
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
    const delay = reconnectBackoffMs(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startGateway();
    }, delay);
    this.reconnectTimer.unref?.();
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
