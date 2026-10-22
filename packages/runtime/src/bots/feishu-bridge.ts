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

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  LarkChannel,
  NormalizedMessage,
  HttpInstance,
  HttpRequestOptions,
} from '@larksuiteoapi/node-sdk';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotSendOptions, BotStatus, SendCapable, BotMessageReadStatus } from './types.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Bound network requests only; this does not limit Agent execution time. */
export function feishuHttpTransport(base: HttpInstance): HttpInstance {
  return {
    ...base,
    request<T, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> {
      const auxiliary = /\/(reactions|read_users)(?:\/|$)/.test(options.url ?? '');
      return base.request<T, R, D>({
        ...options,
        timeout: options.timeout ?? (auxiliary ? 3_000 : 15_000),
      });
    },
  };
}

type ClosableLarkChannel = Pick<LarkChannel, 'disconnect' | 'rawWsClient'>;

/**
 * `LarkChannel.disconnect()` is a no-op until its first handshake marks the
 * channel connected. Close the raw socket first so a failed or cancelled
 * handshake cannot keep reconnecting in the background.
 */
export async function closeLarkChannel(channel: ClosableLarkChannel): Promise<void> {
  try {
    channel.rawWsClient?.close({ force: true });
  } catch {
    // Best effort: the public disconnect path still disposes channel state.
  }
  await channel.disconnect().catch(() => {});
}

export function feishuMessageToEvent(message: NormalizedMessage, receivedAt: number) {
  const resource = message.resources?.[0];
  const mediaOnly = ['image', 'file', 'audio', 'media', 'sticker'].includes(message.rawContentType);
  if ((!message.content.trim() && !resource) || !message.senderId || !message.chatId) return null;
  const kinds = {
    image: 'photo',
    file: 'document',
    audio: 'voice',
    video: 'video',
    sticker: 'sticker',
  } as const;
  return {
    platform: 'feishu' as const,
    userId: message.senderId,
    userName: message.senderName ?? message.senderId,
    chatId: message.chatId,
    isGroup: message.chatType === 'group',
    text: mediaOnly ? '' : message.content,
    sourceMessageId: message.messageId,
    receivedAt,
    ...(resource ? { attachmentKind: kinds[resource.type] } : {}),
  };
}

/** Only summaries use cards; ordinary replies use Markdown posts. Retry IDs stay stable. */
export function feishuAssistantMessages(text: string, options: BotSendOptions) {
  const chunks: string[] = [];
  let chunk = '',
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(JSON.stringify(char));
    if (bytes + size > 12_000 && chunk) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks.map((content, index) => {
    const body = { tag: 'markdown', content };
    const summary = options.summary?.trim();
    // Oversize summaries fall back to the complete body, never truncated text.
    const elements =
      summary && Buffer.byteLength(JSON.stringify(summary)) < 6_000
        ? [
            { tag: 'markdown', content: summary },
            {
              tag: 'collapsible_panel',
              expanded: false,
              header: {
                title: {
                  tag: 'plain_text',
                  content: chunks.length > 1 ? `详情 ${index + 1}/${chunks.length}` : '详情',
                },
              },
              elements: [body],
            },
          ]
        : [body];
    return {
      msg_type: summary ? ('interactive' as const) : ('post' as const),
      content: JSON.stringify(
        summary
          ? { schema: '2.0', body: { elements } }
          : { zh_cn: { title: '', content: [[{ tag: 'md', text: content }]] } },
      ),
      uuid: createHash('sha256')
        .update(`${options.clientMessageId}:${index}`)
        .digest('hex')
        .slice(0, 50),
    };
  });
}

/** Feishu/Lark long-connection bridge backed by the official Channel API. */
export class FeishuBotBridge extends BaseBotAdapter implements SendCapable {
  private channel: LarkChannel | null = null;
  private unsubscribe: Array<() => void> = [];
  private explicitlyStopped = false;

  private lastMessage = new Map<string, string>();
  private reactions = new Map<string, { message: string; reaction: string }>();
  private reactionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    settings: BotChannelSettings,
    private readonly loadSdk = () =>
      createRequire(import.meta.url)(
        '@larksuiteoapi/node-sdk',
      ) as typeof import('@larksuiteoapi/node-sdk'),
  ) {
    super('feishu', settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    const appId = this.settings.appId?.trim() ?? '';
    const appSecret = this.settings.appSecret?.trim() || this.settings.token.trim();
    if (!appId || !appSecret) {
      this.reason = 'feishu_credentials_missing';
      this.readiness = 'scaffolded';
      this.emitStatusChange();
      return;
    }

    this.explicitlyStopped = false;
    let channel: LarkChannel | undefined;
    try {
      // Keep lazy loading synchronous so stop() cannot race a module-loading await.
      const { Domain, LoggerLevel, createLarkChannel, defaultHttpInstance } = this.loadSdk();
      const isLark = this.settings.domain?.trim() === 'larksuite.com';
      channel = createLarkChannel({
        appId,
        appSecret,
        domain: isLark ? Domain.Lark : Domain.Feishu,
        transport: 'websocket',
        // The SDK transport unwraps Axios responses in its response interceptor.
        httpInstance: feishuHttpTransport(defaultHttpInstance as unknown as HttpInstance),
        source: 'maka',
        loggerLevel: LoggerLevel.error,
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        policy: {
          dmMode: this.settings.allowedUserIds?.length ? 'allowlist' : 'open',
          dmAllowlist: [...(this.settings.allowedUserIds ?? [])],
          requireMention: false,
        },
      });
      this.channel = channel;
      this.wire(channel, appId);
      await channel.connect();
      if (this.explicitlyStopped || this.channel !== channel) return;
      this.startedAt = Date.now();
      this.markConnected(channel, appId);
    } catch (error) {
      if (this.explicitlyStopped || (channel && this.channel !== channel)) return;
      this.running = false;
      this.recordFailure(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      if (channel) await this.disconnectChannel(channel);
    }
  }

  async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.running = false;
    await this.reactionQueue;
    await Promise.all([...this.reactions.keys()].map((chat) => this.cancelTypingIndicator(chat)));
    this.lastMessage.clear();
    const channel = this.channel;
    this.channel = null;
    this.clearSubscriptions();
    if (channel) await closeLarkChannel(channel);
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    const channel = this.channel;
    if (!channel || !this.running || !chatId.trim()) return null;
    try {
      let messageId: string;
      if (options?.clientMessageId) {
        let firstId: string | undefined;
        for (const message of feishuAssistantMessages(text, options)) {
          const result = await channel.rawClient.im.v1.message.create({
            params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: message.msg_type,
              content: message.content,
              uuid: message.uuid,
            },
          });
          if (result.code !== 0 || !result.data?.message_id)
            throw Error(`Feishu send failed: ${result.code}`);
          firstId ??= result.data.message_id;
        }
        messageId = firstId!;
      } else {
        const result = await channel.send(
          chatId,
          { markdown: text },
          options?.replyToMessageId ? { replyTo: options.replyToMessageId } : undefined,
        );
        messageId = result.messageId;
      }
      this.readiness = 'operational';
      this.reason = undefined;
      this.lastEventAt = Date.now();
      this.emitStatusChange();
      return messageId;
    } catch (error) {
      this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
      this.recordFailure(error, 'send-failed');
      this.emitStatusChange();
      return null;
    }
  }

  /** Feishu has message reactions rather than a native chat typing API. */
  sendTypingIndicator(chatId: string): Promise<boolean> {
    return this.queueReaction(async () => {
      const channel = this.channel;
      const message = this.lastMessage.get(chatId);
      if (!channel || !this.running || !message) return false;
      const current = this.reactions.get(chatId);
      if (current?.message === message) return true;
      if (current) {
        await channel.removeReaction(current.message, current.reaction);
        this.reactions.delete(chatId);
      }
      const reaction = await channel.addReaction(message, 'Typing');
      this.reactions.set(chatId, { message, reaction });
      return true;
    });
  }

  cancelTypingIndicator(chatId: string): Promise<boolean> {
    return this.queueReaction(async () => {
      const current = this.reactions.get(chatId);
      if (!current) return true;
      if (!this.channel) return false;
      await this.channel.removeReaction(current.message, current.reaction);
      this.reactions.delete(chatId);
      return true;
    });
  }

  private queueReaction(work: () => Promise<boolean>): Promise<boolean> {
    const next = this.reactionQueue.then(work).catch(() => false);
    this.reactionQueue = next;
    return next;
  }

  async getMessageReadStatus(messageId: string, userId: string): Promise<BotMessageReadStatus> {
    if (!this.channel || !this.running) return { state: 'unknown' };
    try {
      const result = await this.channel.rawClient.im.v1.message.readUsers({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id', page_size: 100 },
      });
      if (result.code !== 0) return { state: 'unknown' };
      const user = result.data?.items?.find((entry) => entry.user_id === userId);
      if (user) return { state: 'read' };
      return { state: result.data?.has_more || !result.data ? 'unknown' : 'unread' };
    } catch {
      return { state: 'unknown' };
    }
  }

  override updateSettings(next: BotChannelSettings): { needsRestart: boolean } {
    const needsRestart =
      next.enabled !== this.settings.enabled ||
      next.appId !== this.settings.appId ||
      next.appSecret !== this.settings.appSecret ||
      next.token !== this.settings.token ||
      next.domain !== this.settings.domain;
    this.settings = next;
    if (!needsRestart) {
      this.channel?.updatePolicy({
        dmMode: next.allowedUserIds?.length ? 'allowlist' : 'open',
        dmAllowlist: [...(next.allowedUserIds ?? [])],
      });
    }
    return { needsRestart };
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }

  private wire(channel: LarkChannel, appId: string): void {
    this.unsubscribe.push(
      channel.on('message', (message) => {
        const receivedAt = Date.now();
        const event = feishuMessageToEvent(message, receivedAt);
        if (!event || this.channel !== channel) return;
        const assistant = this.settings.messageHandling === 'assistant';
        if (
          assistant &&
          (event.isGroup ||
            this.settings.allowedUserIds?.length !== 1 ||
            this.settings.allowedUserIds[0] !== event.userId)
        )
          return;
        if (
          this.settings.allowedUserIds?.length &&
          !this.settings.allowedUserIds.includes(event.userId)
        )
          return;
        // DM sends use open_id; task-mode replies use chat_id.
        this.lastMessage.set(assistant ? event.userId : event.chatId, event.sourceMessageId);
        if (this.lastMessage.size > 500)
          this.lastMessage.delete(this.lastMessage.keys().next().value!);
        if (!this.emitIncomingMessage(event)) return;
        this.readiness = 'operational';
        this.reason = undefined;
        this.emitStatusChange();
      }),
      channel.on('error', (error) => {
        if (this.channel !== channel || this.explicitlyStopped) return;
        this.recordFailure(error);
        this.readiness = this.readiness === 'operational' ? 'degraded' : 'configured';
        this.emitStatusChange();
      }),
      channel.on('reconnecting', () => {
        if (this.channel !== channel || this.explicitlyStopped) return;
        this.running = false;
        this.reason = 'reconnecting';
        this.emitStatusChange();
      }),
      channel.on('reconnected', () => {
        if (this.channel !== channel || this.explicitlyStopped) return;
        this.markConnected(channel, appId);
      }),
    );
  }

  /** Shared connected-state transition for the initial handshake and reconnects. */
  private markConnected(channel: LarkChannel, appId: string): void {
    this.running = true;
    this.reason = undefined;
    this.readiness = 'credentials_valid';
    this.identity = {
      id: channel.botIdentity?.openId ?? appId,
      username: appId,
      displayName: channel.botIdentity?.name ?? appId,
    };
    this.emitStatusChange();
  }

  private async disconnectChannel(channel: LarkChannel): Promise<void> {
    if (this.channel === channel) this.channel = null;
    this.clearSubscriptions();
    await closeLarkChannel(channel);
  }

  private clearSubscriptions(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }
}
