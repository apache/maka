import { EventEmitter } from 'node:events';
import { hasBotChannelCredentials, type BotChannelSettings } from '@maka/core';
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
