import type { BotChannelSettings } from '@maka/core';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { WASocket } from 'baileys';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import { closeWhatsAppSocket } from './whatsapp-auth.js';
import type { BotSendOptions, SendCapable } from './types.js';

interface WhatsAppMessageLike {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    participant?: string | null;
    fromMe?: boolean | null;
  };
  pushName?: string | null;
  messageTimestamp?: number | LongLike | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
  } | null;
}

interface LongLike {
  toNumber?(): number;
  low?: number;
}

export function whatsappMessageToEvent(message: WhatsAppMessageLike, now: number) {
  const key = message.key;
  const chatId = key?.remoteJid ?? '';
  if (key?.fromMe || !key?.id || !chatId || chatId === 'status@broadcast') return null;
  const userId = key.participant ?? chatId;
  const text =
    message.message?.conversation ??
    message.message?.extendedTextMessage?.text ??
    message.message?.imageMessage?.caption ??
    message.message?.videoMessage?.caption ??
    '';
  if (!text) return null;
  const timestamp = whatsappTimestampMs(message.messageTimestamp, now);
  return {
    platform: 'whatsapp' as const,
    userId,
    userName: message.pushName?.trim() || userId,
    chatId,
    isGroup: chatId.endsWith('@g.us'),
    text,
    sourceMessageId: key.id,
    receivedAt: timestamp,
  };
}

export function whatsappTimestampMs(
  value: WhatsAppMessageLike['messageTimestamp'],
  fallback: number,
) {
  if (typeof value === 'number' && Number.isFinite(value)) return value * 1_000;
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber() * 1_000;
  }
  if (value && typeof value === 'object' && typeof value.low === 'number') {
    return value.low * 1_000;
  }
  return fallback;
}

export class WhatsAppBotBridge extends BaseBotAdapter implements SendCapable {
  private socket: WASocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private latestSave: Promise<void> = Promise.resolve();

  constructor(
    settings: BotChannelSettings,
    private readonly authDir: string | undefined,
  ) {
    super('whatsapp', settings);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.clearReconnectTimer();
    if (!this.settings.sessionConfigured || !this.authDir) {
      this.running = false;
      this.readiness = botReadinessFromSettings(this.settings);
      this.reason = 'whatsapp-not-linked';
      this.emitStatusChange();
      return;
    }
    const {
      default: makeWASocket,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      useMultiFileAuthState,
    } = await import('baileys');
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const version = await fetchLatestBaileysVersion()
      .then((result) => result.version)
      .catch(() => [2, 3000, 1015901] as [number, number, number]);
    const logger = silentBaileysLogger();
    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Maka', 'Desktop', '0.1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
    });
    this.socket = socket;
    this.latestSave = Promise.resolve();
    let settleStart: ((error?: Error) => void) | undefined;
    const started = new Promise<void>((resolve, reject) => {
      let settled = false;
      settleStart = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
    });
    const startTimeout = setTimeout(() => {
      if (this.socket !== socket || this.running) return;
      const error = new Error('WhatsApp connection timed out');
      this.readiness = 'degraded';
      this.reason = error.message;
      this.emitStatusChange();
      settleStart?.(error);
    }, 30_000);
    startTimeout.unref?.();
    socket.ev.on('creds.update', () => {
      this.latestSave = this.latestSave.then(saveCreds, saveCreds);
    });
    socket.ev.on('messages.upsert', (event) => {
      if (event.type !== 'notify') return;
      for (const message of event.messages) {
        const mapped = whatsappMessageToEvent(message, Date.now());
        if (mapped) this.emitIncomingMessage(mapped);
      }
    });
    socket.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.running = true;
        this.startedAt ??= Date.now();
        this.readiness = 'operational';
        this.reason = undefined;
        this.identity = socket.user
          ? {
              id: socket.user.id,
              ...(socket.user.name ? { displayName: socket.user.name } : {}),
            }
          : undefined;
        this.emitStatusChange();
        clearTimeout(startTimeout);
        settleStart?.();
      } else if (update.connection === 'close' && this.socket === socket) {
        this.socket = null;
        this.running = false;
        this.readiness = 'degraded';
        const error = update.lastDisconnect?.error;
        const loggedOut = connectionStatusCode(error) === 401;
        this.reason = loggedOut ? 'whatsapp-session-expired' : connectionErrorMessage(error);
        this.emitStatusChange();
        clearTimeout(startTimeout);
        settleStart?.(new Error(this.reason));
        if (!this.stopping && !loggedOut) this.scheduleReconnect();
      }
    });
    await started;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) closeWhatsAppSocket(socket, 'Maka WhatsApp bridge stopped');
    await this.latestSave.catch(() => {});
    this.running = false;
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: BotSendOptions,
  ): Promise<string | null> {
    if (!this.socket || !this.running) return null;
    try {
      const result = await this.socket.sendMessage(chatId, { text });
      return result?.key.id ?? null;
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.start().catch(() => {});
    }, 3_000);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return generalizedErrorMessage(error);
  return 'WhatsApp connection closed';
}

function connectionStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error)) return undefined;
  const output = error.output;
  if (!output || typeof output !== 'object' || !('statusCode' in output)) return undefined;
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
}

function silentBaileysLogger() {
  const logger = {
    level: 'silent',
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  };
  return logger;
}
