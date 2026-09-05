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
import { hasBotChannelCredentials, type BotChannelSettings } from '@maka/core/bot-chat-settings';
import type { BotBridge, BotIncomingMessage, BotPlatform, BotStatus } from './types.js';

export abstract class BaseBotAdapter extends EventEmitter implements BotBridge {
  readonly platform: BotPlatform;
  protected settings: BotChannelSettings;
  protected running = false;
  protected startedAt?: number;
  protected lastEventAt?: number;
  protected reason?: string;
  protected readiness: BotStatus['readiness'];
  protected identity: BotStatus['identity'];

  constructor(platform: BotPlatform, settings: BotChannelSettings) {
    super();
    this.platform = platform;
    this.settings = settings;
    this.readiness = botReadinessFromSettings(settings);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): BotStatus {
    return {
      platform: this.platform,
      running: this.running,
      readiness: this.readiness,
      reason: this.reason,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      connection: this.connectionKind(),
      identity: this.identity,
    };
  }

  updateSettings(settings: BotChannelSettings): { needsRestart: boolean } {
    const needsRestart = botSettingsRequireRestart(this.settings, settings);
    this.settings = settings;
    if (needsRestart) this.readiness = botReadinessFromSettings(settings);
    return { needsRestart };
  }

  protected emitIncomingMessage(message: BotIncomingMessage): void {
    this.lastEventAt = message.receivedAt;
    this.emit('message', message);
  }

  protected emitStatusChange(): void {
    this.emit('statusChange', this.getStatus());
  }

  protected connectionKind(): BotStatus['connection'] {
    return 'none';
  }
}

export function botReadinessFromSettings(settings: BotChannelSettings): BotStatus['readiness'] {
  if (!settings.enabled) return 'scaffolded';
  if (!hasBotChannelCredentials(settings)) return 'scaffolded';
  return 'configured';
}

export function botSettingsRequireRestart(
  previous: BotChannelSettings,
  next: BotChannelSettings,
): boolean {
  return (
    previous.enabled !== next.enabled ||
    previous.token !== next.token ||
    previous.appId !== next.appId ||
    previous.appSecret !== next.appSecret ||
    previous.domain !== next.domain ||
    previous.webhookUrl !== next.webhookUrl
  );
}
