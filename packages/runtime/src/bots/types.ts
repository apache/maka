import type { BotProvider, BotReadinessState } from '@maka/core/bot-chat-settings';
import type { BotMessageEvent, BotPlatform } from '@maka/core/bot-events';

export type { BotPlatform };

export interface BotStatus {
  platform: BotPlatform;
  /**
   * Runtime process/polling loop state only. This is not operational
   * readiness; use `readiness` for user-facing health.
   */
  running: boolean;
  readiness: BotReadinessState;
  reason?: string;
  startedAt?: number;
  lastEventAt?: number;
  connection: 'polling' | 'gateway' | 'webhook' | 'none';
  identity?: {
    id?: string;
    username?: string;
    displayName?: string;
  };
}

export type BotIncomingMessage = BotMessageEvent;

export interface BotBridge {
  readonly platform: BotPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getStatus(): BotStatus;
}

/**
 * PR-BOT-REPLY-TO-MESSAGE-0 (external bot research): bot replies should
 * thread under the originating user message so a Telegram group with
 * concurrent conversations does not visually scramble. `replyToMessageId`
 * is the platform-native message id of the message being replied to.
 * Implementations must tolerate a missing/deleted parent (e.g. Telegram
 * uses `allow_sending_without_reply: true`).
 *
 * Only the first chunk of a multi-chunk send is threaded; continuation
 * chunks render as ordinary sequential messages so the receiver sees a
 * single threaded head followed by the continuation, not N forks under
 * the same parent.
 */
export interface BotSendOptions {
  readonly replyToMessageId?: string;
  /**
   * PR-BOT-EPHEMERAL-REPLY-0 (external bot research): when set, the bridge
   * schedules a delete-message call N milliseconds after the send
   * completes. Use for transient system notices (reset ack / help
   * reply / "无法处理" fallback) that should not accumulate in the chat.
   *
   * The actual agent reply must NOT use this — auto-deleting the
   * useful answer would defeat the bot's purpose.
   *
   * Clamped to a 48-hour window in the bridge; Telegram does not let
   * bots delete their own DMs past that, so a longer schedule would
   * silently no-op.
   */
  readonly ephemeralTtlMs?: number;
}

export interface SendCapable {
  sendMessage(chatId: string, text: string, options?: BotSendOptions): Promise<string | null>;
  /**
   * PR-BOT-TYPING-INDICATOR-0 (external bot research): post a one-shot
   * presence/typing signal. Telegram auto-clears it after ~5 seconds;
   * callers wanting sustained indication must call again periodically.
   * Returns `true` if the signal was delivered, `false` on any failure
   * (including unsupported platforms — drops silently rather than throw).
   */
  sendTypingIndicator?(chatId: string): Promise<boolean>;
}

export interface BotTestResult {
  ok: boolean;
  identity?: { id: string; username?: string; displayName?: string };
  messageSent?: boolean;
  capabilities?: Record<string, boolean>;
  error?: string;
  hint?: string;
  /**
   * `false` when `ok` reflects only a shape/non-empty check and the credentials
   * could NOT be verified against a live endpoint (e.g. WeCom AI-bot creds,
   * which the SDK only validates through a WebSocket auth handshake). Callers
   * that persist connection state must NOT downgrade a working channel on the
   * strength of an unverified probe. Absent/`true` means the result came from a
   * real credential probe.
   */
  verified?: boolean;
}
