import {
  Domain,
  LoggerLevel,
  createLarkChannel,
  type LarkChannel,
  type NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotSendOptions, BotStatus, SendCapable } from './types.js';

const HANDSHAKE_TIMEOUT_MS = 15_000;

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

export function feishuMessageToEvent(
  message: NormalizedMessage,
  receivedAt: number,
  allowedUserIds?: ReadonlyArray<string>,
) {
  if (!message.content.trim() || !message.senderId || !message.chatId) return null;
  // PR-BOT-USER-ALLOWLIST-0 / PR1197 review: the Lark SDK policy gate only
  // enforces the allowlist for DMs (PolicyGate.evaluateGroup checks
  // groupAllowlist + requireMention, and this bridge sets requireMention:false),
  // so group messages from unauthorized senders slip past the SDK. Mirror the
  // WeCom/Telegram local check: an empty/absent list allows all, otherwise the
  // sender must be listed. Dropped silently — no bounce that would let scanners
  // enumerate the policy.
  if (allowedUserIds?.length && !allowedUserIds.includes(message.senderId)) return null;
  return {
    platform: 'feishu' as const,
    userId: message.senderId,
    userName: message.senderName ?? message.senderId,
    chatId: message.chatId,
    isGroup: message.chatType === 'group',
    text: message.content,
    sourceMessageId: message.messageId,
    receivedAt,
  };
}

/** Feishu/Lark long-connection bridge backed by the official Channel API. */
export class FeishuBotBridge extends BaseBotAdapter implements SendCapable {
  private channel: LarkChannel | null = null;
  private unsubscribe: Array<() => void> = [];
  private explicitlyStopped = false;

  constructor(settings: BotChannelSettings) {
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
      this.reason = 'missing-feishu-credentials';
      this.readiness = 'scaffolded';
      this.emitStatusChange();
      return;
    }

    this.explicitlyStopped = false;
    const isLark = this.settings.domain?.trim() === 'larksuite.com';
    const channel = createLarkChannel({
      appId,
      appSecret,
      domain: isLark ? Domain.Lark : Domain.Feishu,
      transport: 'websocket',
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

    try {
      await channel.connect();
      if (this.explicitlyStopped || this.channel !== channel) return;
      this.startedAt = Date.now();
      this.markConnected(channel, appId);
    } catch (error) {
      if (this.explicitlyStopped || this.channel !== channel) return;
      this.running = false;
      this.reason = generalizedErrorMessage(error);
      this.readiness = 'configured';
      this.emitStatusChange();
      await this.disconnectChannel(channel);
    }
  }

  async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.running = false;
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
      const result = await channel.send(
        chatId,
        { markdown: text },
        options?.replyToMessageId ? { replyTo: options.replyToMessageId } : undefined,
      );
      this.readiness = 'operational';
      this.reason = undefined;
      this.lastEventAt = Date.now();
      this.emitStatusChange();
      return result.messageId;
    } catch (error) {
      this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
      this.reason = generalizedErrorMessage(error);
      this.emitStatusChange();
      return null;
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
        const event = feishuMessageToEvent(message, receivedAt, this.settings.allowedUserIds);
        if (!event || this.channel !== channel) return;
        this.lastEventAt = receivedAt;
        this.readiness = 'operational';
        this.reason = undefined;
        this.emitIncomingMessage(event);
        this.emitStatusChange();
      }),
      channel.on('error', (error) => {
        if (this.channel !== channel || this.explicitlyStopped) return;
        this.reason = generalizedErrorMessage(error);
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
