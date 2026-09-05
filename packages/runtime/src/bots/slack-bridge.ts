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
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotSendOptions, SendCapable } from './types.js';

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEventEnvelope {
  ack(): Promise<void>;
  body?: {
    event?: SlackMessageEvent;
  };
}

export function slackMessageToEvent(event: SlackMessageEvent, receivedAt: number) {
  if (
    event.type !== 'message' ||
    event.subtype ||
    event.bot_id ||
    !event.user ||
    !event.channel ||
    !event.ts
  ) {
    return null;
  }
  return {
    platform: 'slack' as const,
    userId: event.user,
    userName: event.user,
    chatId: event.channel,
    isGroup: event.channel_type !== 'im',
    text: event.text ?? '',
    // Slack replies must stay on the existing thread. A top-level message uses
    // its own ts as the thread root; a thread reply carries the root in thread_ts.
    sourceMessageId: event.thread_ts ?? event.ts,
    receivedAt,
  };
}

export class SlackBotBridge extends BaseBotAdapter implements SendCapable {
  private socket: SocketModeClient | null = null;
  private web: WebClient | null = null;

  constructor(settings: BotChannelSettings) {
    super('slack', settings);
  }

  async start(): Promise<void> {
    const botToken = this.settings.token.trim();
    const appToken = this.settings.appSecret?.trim() ?? '';
    if (!botToken || !appToken) {
      this.running = false;
      this.readiness = botReadinessFromSettings(this.settings);
      this.reason = 'missing-slack-tokens';
      this.emitStatusChange();
      return;
    }

    this.web = new WebClient(botToken);
    try {
      const identity = await this.web.auth.test();
      if (!identity.ok) throw new Error(identity.error ?? 'Slack auth.test failed');
      this.identity = {
        ...(identity.user_id ? { id: identity.user_id } : {}),
        ...(identity.user ? { username: identity.user, displayName: identity.user } : {}),
      };
      const socket = new SocketModeClient({
        appToken,
        autoReconnectEnabled: true,
      });
      socket.on('slack_event', (envelope: SlackEventEnvelope) => {
        void envelope.ack().catch(() => {});
        const event = envelope.body?.event;
        if (!event) return;
        const mapped = slackMessageToEvent(event, Date.now());
        if (mapped) this.emitIncomingMessage(mapped);
      });
      socket.on('connected', () => {
        this.running = true;
        this.startedAt ??= Date.now();
        this.readiness = 'operational';
        this.reason = undefined;
        this.emitStatusChange();
      });
      socket.on('disconnected', () => {
        if (!this.socket) return;
        this.running = false;
        this.readiness = 'degraded';
        this.reason = 'slack-disconnected';
        this.emitStatusChange();
      });
      this.socket = socket;
      await socket.start();
      this.running = true;
      this.startedAt = Date.now();
      this.readiness = 'operational';
      this.reason = undefined;
      this.emitStatusChange();
    } catch (error) {
      this.running = false;
      this.readiness = 'degraded';
      this.reason = generalizedErrorMessage(error);
      this.emitStatusChange();
      await this.stopTransport();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stopTransport();
    this.running = false;
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    if (!this.web || !this.running) return null;
    try {
      const result = await this.web.chat.postMessage({
        channel: chatId,
        text,
        ...(options?.replyToMessageId ? { thread_ts: options.replyToMessageId } : {}),
      });
      return typeof result.ts === 'string' ? result.ts : null;
    } catch (error) {
      this.readiness = 'degraded';
      this.reason = generalizedErrorMessage(error);
      this.emitStatusChange();
      return null;
    }
  }

  protected override connectionKind(): 'gateway' {
    return 'gateway';
  }

  private async stopTransport(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.web = null;
    if (socket) await socket.disconnect().catch(() => {});
  }
}
