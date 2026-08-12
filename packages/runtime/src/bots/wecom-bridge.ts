import { WSClient, type TextMessage, type WsFrame } from '@wecom/aibot-node-sdk';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotSendOptions, BotStatus, SendCapable } from './types.js';

const AUTH_TIMEOUT_MS = 15_000;

type ClosableWeComClient = Pick<WSClient, 'disconnect' | 'removeAllListeners'>;

/** Detach bridge callbacks before disconnect can synchronously emit. */
export function closeWeComClient(client: ClosableWeComClient): void {
  client.removeAllListeners();
  client.disconnect();
}

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function wecomTextFrameToEvent(
  frame: WsFrame<TextMessage>,
  receivedAt: number,
  allowedUserIds?: ReadonlyArray<string>,
) {
  const body = frame.body;
  if (!body || body.msgtype !== 'text' || typeof body.text?.content !== 'string') return null;
  const userId = body.from?.userid;
  if (typeof userId !== 'string' || !userId) return null;
  if (allowedUserIds?.length && !allowedUserIds.includes(userId)) return null;
  const isGroup = body.chattype === 'group';
  const chatId = isGroup ? body.chatid : userId;
  if (typeof chatId !== 'string' || !chatId) return null;
  return {
    platform: 'wecom' as const,
    userId,
    userName: userId,
    chatId,
    isGroup,
    text: body.text.content,
    sourceMessageId: body.msgid,
    receivedAt,
  };
}

/** Enterprise WeChat AI Bot WebSocket bridge backed by the official SDK. */
export class WeComBotBridge extends BaseBotAdapter implements SendCapable {
  private client: WSClient | null = null;
  private explicitlyStopped = false;

  constructor(settings: BotChannelSettings) {
    super('wecom', settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    const botId = this.settings.appId?.trim() ?? '';
    const secret = this.settings.appSecret?.trim() ?? '';
    if (!botId || !secret) {
      this.reason = 'no-credentials';
      this.readiness = 'scaffolded';
      this.emitStatusChange();
      return;
    }

    this.explicitlyStopped = false;
    const client = new WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
      logger: quietLogger,
    });
    this.client = client;
    this.wire(client, botId);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAuthenticated = () => finish(resolve);
      const onError = (error: Error) => finish(() => reject(error));
      const cleanup = () => {
        clearTimeout(timer);
        client.off('authenticated', onAuthenticated);
        client.off('error', onError);
      };
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('WeCom authentication timed out'))),
        AUTH_TIMEOUT_MS,
      );
      client.once('authenticated', onAuthenticated);
      client.once('error', onError);
      client.connect();
    })
      .then(() => {
        if (this.explicitlyStopped || this.client !== client) return;
        this.running = true;
        this.startedAt = Date.now();
        this.identity = { id: botId, username: botId, displayName: botId };
        this.reason = undefined;
        this.readiness = 'credentials_valid';
        this.emitStatusChange();
      })
      .catch((error) => {
        if (this.explicitlyStopped || this.client !== client) return;
        this.running = false;
        this.reason = generalizedErrorMessage(error);
        this.readiness = 'configured';
        this.emitStatusChange();
        this.client = null;
        closeWeComClient(client);
      });
  }

  async stop(): Promise<void> {
    this.explicitlyStopped = true;
    this.running = false;
    const client = this.client;
    this.client = null;
    if (client) closeWeComClient(client);
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: BotSendOptions,
  ): Promise<string | null> {
    const client = this.client;
    if (!client || !this.running || !chatId.trim()) return null;
    try {
      const response = await client.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
      this.readiness = 'operational';
      this.reason = undefined;
      this.lastEventAt = Date.now();
      this.emitStatusChange();
      return response.headers?.req_id ?? null;
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
      next.appSecret !== this.settings.appSecret;
    this.settings = next;
    return { needsRestart };
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }

  private wire(client: WSClient, botId: string): void {
    client.on('message.text', (frame) => {
      const receivedAt = Date.now();
      const event = wecomTextFrameToEvent(frame, receivedAt, this.settings.allowedUserIds);
      if (!event || this.client !== client) return;
      this.lastEventAt = receivedAt;
      this.readiness = 'operational';
      this.reason = undefined;
      this.emitIncomingMessage(event);
      this.emitStatusChange();
    });
    client.on('authenticated', () => {
      if (this.client !== client) return;
      this.running = true;
      this.identity = { id: botId, username: botId, displayName: botId };
      this.reason = undefined;
      this.readiness = 'credentials_valid';
      this.emitStatusChange();
    });
    client.on('disconnected', (reason) => {
      if (this.client !== client || this.explicitlyStopped) return;
      this.running = false;
      this.reason = reason || 'disconnected';
      this.readiness = this.readiness === 'operational' ? 'degraded' : 'configured';
      this.emitStatusChange();
    });
    client.on('reconnecting', () => {
      if (this.client !== client || this.explicitlyStopped) return;
      this.reason = 'reconnecting';
      this.emitStatusChange();
    });
    client.on('error', (error) => {
      if (this.client !== client || this.explicitlyStopped) return;
      this.reason = generalizedErrorMessage(error);
      this.readiness = this.readiness === 'operational' ? 'degraded' : 'configured';
      this.emitStatusChange();
    });
  }
}
