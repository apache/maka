import type { BotAttachmentKind } from '@maka/core/bot-events';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import type { BotPlatform, BotSendOptions, BotStatus, SendCapable } from './types.js';
import { proxiedFetch } from './proxied-fetch.js';

const TELEGRAM_POLL_TIMEOUT_S = 15;
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
const FEISHU_REQUEST_TIMEOUT_MS = 10_000;

/**
 * PR-TELEGRAM-UTF16-LIMIT-0 (external bot research #B3): Telegram's
 * 4096-character message cap is measured in UTF-16 code units, NOT
 * Python-style codepoints. Astral-plane characters (most emoji, CJK
 * Extension B, music symbols) consume 2 code units each. Without
 * this guard, an emoji-heavy 2049-codepoint message overflows the
 * 4096 limit and Telegram returns 400.
 *
 * Limit pulled DOWN to 4000 so a "[1/N]" continuation marker fits
 * inside the cap on the producer side without re-measuring.
 */
const TELEGRAM_MAX_UTF16_PER_MESSAGE = 4000;

/** Count UTF-16 code units in `s` (surrogate pairs count as 2). */
function utf16Len(s: string): number {
  return s.length === 0 ? 0 : Buffer.byteLength(s, 'utf16le') / 2;
}

/**
 * Return the longest prefix of `s` whose UTF-16 length is ≤ `cap`,
 * respecting surrogate-pair boundaries (we never slice a
 * multi-code-unit character in half). We iterate codepoint-by-
 * codepoint instead of binary-searching slices: the cost of
 * mistakenly splitting an emoji is far worse than the O(n) cost.
 */
function prefixWithinUtf16(s: string, cap: number): string {
  if (utf16Len(s) <= cap) return s;
  let used = 0;
  let end = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!;
    const units = code > 0xffff ? 2 : 1;
    if (used + units > cap) break;
    used += units;
    i += units;
    end = i;
  }
  return s.slice(0, end);
}

/**
 * Split `text` into UTF-16-bounded chunks for Telegram delivery.
 * Prefers breaking on a newline within the last ~10% of the chunk;
 * falls back to a hard prefix cut when the chunk has no newline.
 *
 * The chunk count is emitted as a `[i/N]` header on the first
 * line of each piece so the receiver knows the message is split.
 */
function splitForTelegram(text: string): string[] {
  if (utf16Len(text) <= TELEGRAM_MAX_UTF16_PER_MESSAGE) return [text];
  const HEADER_RESERVE = 12; // room for "[99/99]\n"
  const cap = TELEGRAM_MAX_UTF16_PER_MESSAGE - HEADER_RESERVE;
  const pieces: string[] = [];
  let remaining = text;
  while (utf16Len(remaining) > cap) {
    let chunk = prefixWithinUtf16(remaining, cap);
    const minBoundary = Math.floor(chunk.length * 0.9);
    const nl = chunk.lastIndexOf('\n');
    if (nl >= minBoundary) chunk = chunk.slice(0, nl);
    pieces.push(chunk);
    remaining = remaining.slice(chunk.length).replace(/^\n/, '');
  }
  if (remaining.length > 0) pieces.push(remaining);
  const total = pieces.length;
  return pieces.map((piece, idx) => `[${idx + 1}/${total}]\n${piece}`);
}

/**
 * PR-BOT-REPLY-TO-MESSAGE-0: build the Telegram `sendMessage` body for
 * one chunk. `chunkIndex === 0` is the first chunk of a split send and
 * is the only piece that threads under the originating user message.
 * Continuation chunks render as ordinary sequential messages.
 *
 * `allow_sending_without_reply: true` lets Telegram still deliver if
 * the parent message was deleted — preserving Maka's response rather
 * than rejecting it with 400.
 */
function buildTelegramSendBody(
  chatId: string,
  chunk: string,
  options: BotSendOptions | undefined,
  chunkIndex: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: chunk,
  };
  const replyToMessageId = normalizeTelegramReplyToMessageId(options?.replyToMessageId);
  if (chunkIndex === 0 && replyToMessageId !== undefined) {
    body.reply_to_message_id = replyToMessageId;
    body.allow_sending_without_reply = true;
  }
  return body;
}

function normalizeTelegramReplyToMessageId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
  const numeric = Number(trimmed);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}

/**
 * PR-BOT-USER-ALLOWLIST-0: runtime allowlist gate. `undefined` or empty
 * means no restriction; any other set is enforced as exact match against
 * the platform-native user id. The settings normalize layer already
 * trims, dedups, and caps the persisted array, so this function only
 * has to do membership.
 */
function isAllowedUser(allowedUserIds: ReadonlyArray<string> | undefined, userId: string): boolean {
  if (!allowedUserIds || allowedUserIds.length === 0) return true;
  return allowedUserIds.includes(userId);
}

/**
 * PR-BOT-NON-TEXT-MESSAGE-ACK-0 (external bot research): map a Telegram
 * `message` object to a stable {@link BotAttachmentKind} so the handler
 * can choose between an ingest path (text-bearing) and an ack-only
 * path (non-text payload that Maka cannot interpret yet).
 *
 * Order matters: photo / voice / video are the most common and we want
 * the most accurate label for them. `sticker` and `animation` overlap
 * with images/videos at the Telegram protocol level — they get their
 * own ack copy so the user is not told "send a photo's question" when
 * what they sent was a sticker.
 */
function telegramAttachmentKind(message: any): BotAttachmentKind | undefined {
  if (!message || typeof message !== 'object') return undefined;
  if (Array.isArray(message.photo) && message.photo.length > 0) return 'photo';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.sticker) return 'sticker';
  if (message.animation) return 'animation';
  if (message.video || message.video_note) return 'video';
  if (message.document) return 'document';
  if (message.location || message.contact || message.poll || message.dice || message.venue)
    return 'unknown';
  return undefined;
}

/**
 * PR-BOT-EPHEMERAL-REPLY-0 (external bot research): decide whether the
 * caller asked for ephemeral cleanup, and if so how long to wait.
 * Returns `undefined` when no cleanup should be scheduled. Telegram
 * silently refuses bot self-delete past 48 hours in DMs, so clamping
 * here prevents scheduling a timer that has no chance of succeeding.
 * The lower bound of 1s defends against an immediate-self-delete that
 * would race the send completing on the receiver.
 */
const EPHEMERAL_REPLY_MIN_MS = 1_000;
const EPHEMERAL_REPLY_MAX_MS = 48 * 60 * 60 * 1_000;

function ephemeralDelayFromOptions(options: BotSendOptions | undefined): number | undefined {
  if (!options || typeof options.ephemeralTtlMs !== 'number') return undefined;
  if (!Number.isFinite(options.ephemeralTtlMs) || options.ephemeralTtlMs <= 0) return undefined;
  return Math.min(Math.max(options.ephemeralTtlMs, EPHEMERAL_REPLY_MIN_MS), EPHEMERAL_REPLY_MAX_MS);
}

/**
 * PR-BOT-RATELIMIT-RETRY-0 (external bot research): classify a Telegram
 * sendMessage response so the caller can decide between "done", "retry
 * after Telegram's stated backoff", and "give up". Pure on the
 * response object so the decision can be unit-tested without mocking
 * the network.
 *
 * Why 429 specifically: Telegram's per-chat rate limits trigger 429s
 * with a `parameters.retry_after` integer (seconds). A short, bounded
 * retry handles the burst case (e.g. agent finished and emits 5 chunks
 * back-to-back) without silently dropping the message. Other failure
 * codes (400 bad request, 401 unauthorized, 403 forbidden, 5xx) are
 * NOT retried — 4xx is permanent and 5xx Telegram outages do not
 * resolve in a 30s window.
 *
 * Bounds:
 *   - Retry delay is clamped to [1000ms, 30_000ms]. Telegram has been
 *     observed to return inflated retry_after values during incidents;
 *     a 30s cap keeps the bridge responsive.
 *   - Exactly one retry. We do not loop — if the second attempt also
 *     returns 429 the caller marks degraded and returns. Repeated 429
 *     under load is a deployment / rate-policy issue, not something an
 *     unbounded retry loop should mask.
 */
export type TelegramSendClassification =
  | { kind: 'ok'; messageId: string | null }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'fatal'; description: string };

const TELEGRAM_RETRY_MIN_MS = 1_000;
const TELEGRAM_RETRY_MAX_MS = 30_000;

function classifyTelegramSendResponse(response: any): TelegramSendClassification {
  if (response && response.ok === true) {
    const id = response.result?.message_id;
    return {
      kind: 'ok',
      messageId: typeof id === 'number' || typeof id === 'string' ? String(id) : null,
    };
  }
  if (response && response.error_code === 429) {
    const raw = Number(response.parameters?.retry_after ?? 0);
    const requested = Number.isFinite(raw) && raw > 0 ? raw * 1000 : TELEGRAM_RETRY_MIN_MS;
    const delayMs = Math.min(Math.max(requested, TELEGRAM_RETRY_MIN_MS), TELEGRAM_RETRY_MAX_MS);
    return { kind: 'retry', delayMs };
  }
  const description =
    typeof response?.description === 'string' ? response.description : 'send-failed';
  return { kind: 'fatal', description };
}

export const __TEST__ = {
  utf16Len,
  prefixWithinUtf16,
  splitForTelegram,
  buildTelegramSendBody,
  normalizeTelegramReplyToMessageId,
  isAllowedUser,
  classifyTelegramSendResponse,
};

export class SimpleBotBridge extends BaseBotAdapter implements SendCapable {
  private abortController: AbortController | null = null;
  private offset = 0;

  constructor(platform: BotPlatform, settings: BotChannelSettings) {
    super(platform, settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    if (!this.settings.token.trim()) {
      this.reason = 'no-token';
      this.readiness = 'scaffolded';
      return;
    }

    if (this.platform === 'telegram') {
      await this.startTelegram();
      return;
    }

    if (this.platform === 'feishu') {
      await this.startFeishu();
      return;
    }

    if (this.platform === 'discord') {
      this.running = false;
      this.reason = 'scaffold-only';
      this.readiness = 'configured';
      this.emitStatusChange();
      return;
    }

    this.reason = 'unimplemented';
    this.readiness = 'scaffolded';
    this.emitStatusChange();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: BotSendOptions,
  ): Promise<string | null> {
    if (this.platform !== 'telegram' || !this.running) return null;
    // PR-TELEGRAM-UTF16-LIMIT-0: split first if the message would
    // exceed Telegram's 4096 UTF-16 code unit cap. The split helper
    // returns the original text untouched when it already fits, so
    // the common short-message path stays a single API call.
    const chunks = splitForTelegram(text);
    let lastMessageId: string | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const body = buildTelegramSendBody(chatId, chunk, options, i);
      // PR-BOT-RATELIMIT-RETRY-0: one bounded retry on Telegram 429.
      // Burst-send (agent emits 5 chunks back-to-back) is exactly the
      // case this targets — without the retry, chunk 2 silently drops
      // and the user sees a truncated reply.
      let response = await telegramApi(this.settings.token, 'sendMessage', body);
      let classification = classifyTelegramSendResponse(response);
      if (classification.kind === 'retry') {
        await sleep(classification.delayMs);
        response = await telegramApi(this.settings.token, 'sendMessage', body);
        classification = classifyTelegramSendResponse(response);
      }
      if (classification.kind !== 'ok') {
        this.readiness = this.readiness === 'operational' ? 'degraded' : 'credentials_valid';
        this.reason = classification.kind === 'retry' ? 'rate-limited' : classification.description;
        this.emitStatusChange();
        return null;
      }
      lastMessageId = classification.messageId ?? lastMessageId;
    }
    this.readiness = 'operational';
    this.reason = undefined;
    this.lastEventAt = Date.now();
    this.emitStatusChange();
    // PR-BOT-EPHEMERAL-REPLY-0: schedule a self-delete of the FIRST
    // message we sent (system notice TTL). Multi-chunk sends keep
    // their tail visible — only the head is treated as the "system
    // notice" worth garbage-collecting. We attach this AFTER the
    // status emit so a failure here cannot regress the successful-send
    // contract observed by listeners.
    const ephemeralDelay = ephemeralDelayFromOptions(options);
    if (ephemeralDelay !== undefined && lastMessageId) {
      const token = this.settings.token;
      const targetMessageId = lastMessageId;
      const targetChatId = chatId;
      setTimeout(() => {
        void telegramApi(token, 'deleteMessage', {
          chat_id: targetChatId,
          message_id: Number(targetMessageId),
        }).catch(() => undefined);
      }, ephemeralDelay).unref?.();
    }
    return lastMessageId;
  }

  /**
   * PR-BOT-TYPING-INDICATOR-0: post Telegram's `sendChatAction` so the
   * "Maka is typing…" affordance shows in the client while the agent
   * generates its reply. Failure is swallowed — typing is decorative
   * and must never block / corrupt the actual reply path.
   */
  async sendTypingIndicator(chatId: string): Promise<boolean> {
    if (this.platform !== 'telegram' || !this.running) return false;
    try {
      const response = await telegramApi(this.settings.token, 'sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  private async startTelegram(): Promise<void> {
    try {
      const me = await telegramApi(this.settings.token, 'getMe');
      if (!me.ok) {
        this.reason = me.description ?? 'get-me-failed';
        this.readiness = 'configured';
        this.emitStatusChange();
        return;
      }
      this.identity = {
        id: String(me.result?.id ?? ''),
        username: me.result?.username,
        displayName: me.result?.first_name,
      };
      this.running = true;
      this.startedAt = Date.now();
      this.reason = undefined;
      // getMe proves credentials and API reachability. It is not a
      // send/receive smoke, so it must not be surfaced as operational.
      this.readiness = 'credentials_valid';
      this.emitStatusChange();
      void this.pollTelegram();
    } catch (error) {
      this.reason = generalizedErrorMessage(error);
      this.readiness =
        this.readiness === 'operational' ? 'degraded' : botReadinessFromSettings(this.settings);
      this.emitStatusChange();
    }
  }

  private async startFeishu(): Promise<void> {
    try {
      const appId = this.settings.appId?.trim() ?? '';
      const appSecret = this.settings.appSecret?.trim() || this.settings.token.trim();
      if (!appId || !appSecret) {
        this.running = false;
        this.reason = 'missing-feishu-credentials';
        this.readiness = 'scaffolded';
        this.emitStatusChange();
        return;
      }
      const token = await feishuTenantAccessToken(appId, appSecret);
      if (!token.ok) {
        this.running = false;
        this.reason = token.error;
        this.readiness = 'configured';
        this.emitStatusChange();
        return;
      }
      this.identity = {
        id: appId,
        username: appId,
        displayName: appId,
      };
      this.running = false;
      this.startedAt = Date.now();
      this.reason = this.settings.domain?.trim()
        ? 'feishu-events-not-connected'
        : 'feishu-domain-required';
      // tenant_access_token proves app credentials. Feishu event delivery still
      // needs a callback/long-connection runtime before it can be operational.
      this.readiness = 'credentials_valid';
      this.emitStatusChange();
    } catch (error) {
      this.running = false;
      this.reason = generalizedErrorMessage(error);
      this.readiness =
        this.readiness === 'operational' ? 'degraded' : botReadinessFromSettings(this.settings);
      this.emitStatusChange();
    }
  }

  private async pollTelegram(): Promise<void> {
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const updates = await telegramApi(
          this.settings.token,
          'getUpdates',
          {
            offset: this.offset,
            timeout: TELEGRAM_POLL_TIMEOUT_S,
            allowed_updates: ['message'],
          },
          this.abortController.signal,
        );
        if (!updates.ok || !Array.isArray(updates.result)) {
          await sleep(5_000);
          continue;
        }
        for (const update of updates.result) {
          this.offset = Number(update.update_id ?? this.offset) + 1;
          this.handleTelegramMessage(update.message);
        }
      } catch (error) {
        if (!this.running) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        await sleep(5_000);
      }
    }
  }

  private handleTelegramMessage(message: any): void {
    if (!message?.from) return;
    const userId = String(message.from.id);
    // PR-BOT-USER-ALLOWLIST-0: drop unauthorized senders silently when an
    // allowlist is configured. No bounce reply — that would let scanners
    // enumerate the policy by toggling IDs. Status fields are NOT updated
    // for dropped messages so the bridge's `lastEventAt` continues to
    // reflect authentic activity from authorized users only.
    if (!isAllowedUser(this.settings.allowedUserIds, userId)) return;
    this.lastEventAt = Date.now();
    this.readiness = 'operational';
    this.reason = undefined;
    const attachmentKind = telegramAttachmentKind(message);
    this.emitIncomingMessage({
      platform: 'telegram',
      userId,
      userName: message.from.username ?? message.from.first_name ?? userId,
      chatId: String(message.chat?.id ?? ''),
      isGroup: message.chat?.type === 'group' || message.chat?.type === 'supergroup',
      text: message.text ?? message.caption ?? '',
      sourceMessageId: String(message.message_id ?? ''),
      receivedAt: this.lastEventAt,
      ...(attachmentKind ? { attachmentKind } : {}),
    });
    this.emitStatusChange();
  }

  protected override connectionKind(): BotStatus['connection'] {
    if (this.platform === 'telegram') return 'polling';
    if (this.platform === 'discord' || this.platform === 'feishu') return 'gateway';
    return 'none';
  }
}

async function telegramApi(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const timeoutMs =
    typeof body?.timeout === 'number' ? (body.timeout + 5) * 1_000 : TELEGRAM_REQUEST_TIMEOUT_MS;
  const response = await proxiedFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    timeoutMs,
  });
  return response.json();
}

async function feishuTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const response = await proxiedFetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: FEISHU_REQUEST_TIMEOUT_MS,
    },
  );
  const json = await response.json();
  if (json.code !== 0 || !json.tenant_access_token) {
    return { ok: false, error: json.msg ?? 'Failed to issue tenant_access_token' };
  }
  return { ok: true, token: json.tenant_access_token };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
