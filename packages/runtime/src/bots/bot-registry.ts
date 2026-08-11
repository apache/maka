import { EventEmitter } from 'node:events';
import {
  hasBotChannelCredentials,
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
import { SimpleBotBridge } from './simple-bridge.js';
import type {
  BotBridge,
  BotIncomingMessage,
  BotPlatform,
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

    if (!isImplemented(platform)) {
      const status = scaffoldStatus(platform, settings);
      this.statuses.set(platform, status);
      this.deps.onStatusChange(status);
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
                    : new SimpleBotBridge(platform, settings);
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

function isImplemented(platform: BotPlatform): boolean {
  return (
    platform === 'telegram' ||
    platform === 'feishu' ||
    platform === 'wecom' ||
    platform === 'wechat' ||
    platform === 'discord' ||
    platform === 'dingtalk' ||
    platform === 'qq' ||
    platform === 'slack'
  );
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

function scaffoldStatus(platform: BotPlatform, settings: BotChannelSettings): BotStatus {
  // PR-HEALTH-1 (xuan msg `e4887ffd`, I1 — bot readiness single-authority,
  // read path): the previous behavior inherited `settings.readiness ===
  // 'credentials_valid'` blindly, which leaked stale persisted state into
  // `BotStatus.readiness` for unimplemented platforms (everything except
  // telegram in V0.2). The settings write path (settings.ts
  // `coerceReadinessForCurrentState`) already downgrades implausible
  // persisted states; this read path drops the special-case to make the
  // gate doubly safe.
  //
  // Authoritative readiness sources, post-PR-HEALTH-1:
  //   1. Live bridge (`SimpleBotBridge` for telegram) — writes its own
  //      `readiness` field during lifecycle; surfaced via `BotBridge.getStatus()`.
  //   2. Settings-derived for unimplemented platforms — computed FRESH
  //      from current `channel.{enabled, token, appId, appSecret}` via
  //      `readinessFromSettings`. Persisted `settings.readiness` is no
  //      longer trusted at the read boundary.
  return {
    platform,
    running: false,
    readiness: readinessFromSettings(settings),
    reason:
      settings.token.trim() || settings.appId || settings.appSecret
        ? 'scaffold-only'
        : 'unimplemented',
    connection: 'none',
  };
}

function readinessFromSettings(settings: BotChannelSettings): BotStatus['readiness'] {
  if (!settings.enabled) return 'scaffolded';
  if (!hasBotChannelCredentials(settings)) return 'scaffolded';
  return 'configured';
}
