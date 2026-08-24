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

import { EventEmitter } from 'node:events';
import {
  type BotChannelSettings,
  type BotChatSettings,
  type BotProvider,
} from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { BOT_PROVIDERS } from '@maka/core/settings';
import { DingTalkBotBridge } from './dingtalk-bridge.js';
import { FeishuBotBridge } from './feishu-bridge.js';
import { DiscordBotBridge } from './discord-bridge.js';
import { QQBotBridge } from './qq-bridge.js';
import { SlackBotBridge } from './slack-bridge.js';
import { TelegramBotBridge } from './telegram-bridge.js';
import type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
  BotReplyStream,
  BotReplyStreamOptions,
  BotSendOptions,
  BotStatus,
  SendCapable,
} from './types.js';
import { WechatBridge } from './wechat-bridge.js';
import { WeComBotBridge } from './wecom-bridge.js';

export interface BotRegistryDeps {
  onIncomingMessage: (message: BotIncomingMessage) => void;
  onStatusChange: (status: BotStatus) => void;
}

export class BotRegistry extends EventEmitter {
  private bridges = new Map<BotPlatform, BotBridge>();
  private statuses = new Map<BotPlatform, BotStatus>();
  private applyQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BotRegistryDeps) {
    super();
  }

  async applySettings(settings: BotChatSettings): Promise<void> {
    const next = this.applyQueue.then(
      () => this.applySettingsNow(settings),
      () => this.applySettingsNow(settings),
    );
    this.applyQueue = next.catch(() => {});
    return next;
  }

  getStatus(platform: BotPlatform): BotStatus {
    return (
      this.bridges.get(platform)?.getStatus() ??
      this.statuses.get(platform) ??
      defaultStatus(platform)
    );
  }

  allStatuses(): Record<BotProvider, BotStatus> {
    return Object.fromEntries(
      BOT_PROVIDERS.map((provider) => [provider, this.getStatus(provider)]),
    ) as Record<BotProvider, BotStatus>;
  }

  async sendMessage(
    platform: BotPlatform,
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    const bridge = this.bridges.get(platform) as (BotBridge & Partial<SendCapable>) | undefined;
    if (!bridge || typeof bridge.sendMessage !== 'function') return null;
    return bridge.sendMessage(chatId, text, options);
  }

  startReplyStream(
    platform: BotPlatform,
    chatId: string,
    options: BotReplyStreamOptions,
  ): BotReplyStream | null {
    const bridge = this.bridges.get(platform) as (BotBridge & Partial<SendCapable>) | undefined;
    if (!bridge || typeof bridge.startReplyStream !== 'function') return null;
    return bridge.startReplyStream(chatId, options);
  }

  /**
   * PR-BOT-TYPING-INDICATOR-0: best-effort typing affordance. Returns
   * `false` when no bridge is registered for the platform or when the
   * bridge does not implement `sendTypingIndicator`. Never throws —
   * typing is decorative.
   */
  async sendTypingIndicator(platform: BotPlatform, chatId: string): Promise<boolean> {
    const bridge = this.bridges.get(platform) as (BotBridge & Partial<SendCapable>) | undefined;
    if (!bridge || typeof bridge.sendTypingIndicator !== 'function') return false;
    return bridge.sendTypingIndicator(chatId);
  }

  async stopAll(): Promise<void> {
    const next = this.applyQueue.then(
      () => this.stopAllNow(),
      () => this.stopAllNow(),
    );
    this.applyQueue = next.catch(() => {});
    return next;
  }

  private async applySettingsNow(settings: BotChatSettings): Promise<void> {
    await Promise.all(
      BOT_PROVIDERS.map((provider) => this.reconcileOne(provider, settings.channels[provider])),
    );
  }

  private async stopAllNow(): Promise<void> {
    await Promise.all([...this.bridges.values()].map((bridge) => bridge.stop().catch(() => {})));
    this.bridges.clear();
    this.statuses.clear();
  }

  private async reconcileOne(platform: BotPlatform, settings: BotChannelSettings): Promise<void> {
    const existing = this.bridges.get(platform);
    if (!settings.enabled) {
      if (existing) {
        await existing.stop().catch(() => {});
        this.bridges.delete(platform);
      }
      this.statuses.set(platform, defaultStatus(platform));
      this.deps.onStatusChange(this.getStatus(platform));
      return;
    }

    if (existing) {
      const update = (
        existing as { updateSettings?: (next: BotChannelSettings) => { needsRestart: boolean } }
      ).updateSettings;
      if (update && !update.call(existing, settings).needsRestart) return;
      await existing.stop().catch(() => {});
      // Drop our 'message' / 'statusChange' listeners on the old
      // bridge before dereferencing it. Some bridges (Discord
      // gateway, WeChat poll) hold async tasks that can still emit
      // after `stop()` returns; without removeAllListeners those
      // emissions would race-call onIncomingMessage / onStatusChange
      // against a bridge the registry already considers gone.
      try {
        (existing as BotBridge & EventEmitter).removeAllListeners('message');
        (existing as BotBridge & EventEmitter).removeAllListeners('statusChange');
      } catch {
        // best-effort — non-EventEmitter bridges don't have listeners to clear.
      }
    }
    this.statuses.delete(platform);

    const bridge =
      platform === 'wechat'
        ? new WechatBridge(settings)
        : platform === 'wecom'
          ? new WeComBotBridge(settings)
          : platform === 'feishu'
            ? new FeishuBotBridge(settings)
            : platform === 'discord'
              ? new DiscordBotBridge(platform, settings)
              : platform === 'dingtalk'
                ? new DingTalkBotBridge(platform, settings)
                : platform === 'qq'
                  ? new QQBotBridge(platform, settings)
                  : platform === 'slack'
                    ? new SlackBotBridge(settings)
                    : new TelegramBotBridge(platform, settings);
    this.wire(bridge);
    this.bridges.set(platform, bridge);
    await bridge
      .start()
      .catch((error) =>
        console.error(`[BotRegistry] ${platform} start failed: ${generalizedErrorMessage(error)}`),
      );
  }

  private wire(bridge: BotBridge): void {
    const emitter = bridge as BotBridge & EventEmitter;
    emitter.on('message', (message: BotIncomingMessage) => this.deps.onIncomingMessage(message));
    emitter.on('statusChange', (status: BotStatus) => this.deps.onStatusChange(status));
  }
}

function defaultStatus(platform: BotPlatform): BotStatus {
  return {
    platform,
    running: false,
    readiness: 'scaffolded',
    reason: 'disabled',
    connection: 'none',
  };
}
