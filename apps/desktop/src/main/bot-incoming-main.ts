import { createHash, randomUUID } from 'node:crypto';
import {
  botConversationKey,
  botDisplayLabel,
  botSourceEventKey,
  formatBotMessageForSession,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  nonTextMessageAck,
  plaintextHelpReply,
} from '@maka/core/bot-events';
import { generalizedErrorMessage } from '@maka/core/redaction';
import type { BotIncomingMessage, BotRegistry, BotReplyStream } from '@maka/runtime/bots';
import type { BotSessionAdapter, BotSessionTurnResult } from './bot-session-adapter.js';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

const BOT_RECENT_SOURCE_EVENT_LIMIT = 1_000;
const BOT_RECENT_SOURCE_EVENT_TTL_MS = 60 * 60 * 1_000;
const BOT_CONVERSATION_RATE_BURST = 8;
const BOT_CONVERSATION_RATE_REFILL_MS = 5_000;
const BOT_CONVERSATION_RATE_BUCKET_TTL_MS = 60 * 60 * 1_000;
const BOT_CONVERSATION_RATE_BUCKET_LIMIT = 1_000;

interface BotConversationRateBucket {
  tokens: number;
  updatedAt: number;
}

export interface BotIncomingMainService {
  handleBotIncomingMessage(message: BotIncomingMessage): Promise<void>;
  close(): Promise<void>;
}

interface BotIncomingMainServiceDeps {
  sessions: BotSessionAdapter;
  botRegistry: BotRegistry;
  newId?: () => string;
}

export function createBotIncomingMainService(deps: BotIncomingMainServiceDeps): BotIncomingMainService {
  const newId = deps.newId ?? randomUUID;
  const botConversationQueues = new Map<string, Promise<void>>();
  const botRecentSourceEventKeys = new Map<string, number>();
  const botConversationRateBuckets = new Map<string, BotConversationRateBucket>();
  const activeTasks = new Set<Promise<void>>();
  let closed = false;
  let closeTask: Promise<void> | undefined;

  function handleBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    if (closed) return Promise.resolve();
    const task = handleAcceptedBotIncomingMessage(message);
    const tracked = task.finally(() => activeTasks.delete(tracked));
    activeTasks.add(tracked);
    return tracked;
  }

  async function handleAcceptedBotIncomingMessage(message: BotIncomingMessage): Promise<void> {
    if (rememberBotSourceEvent(message)) return;
    const text = message.text.trim();
    // PR-BOT-NON-TEXT-MESSAGE-ACK-0: previously a photo / voice / sticker
    // with no caption was silently dropped — the user got zero response.
    // If the inbound carried a non-text payload and there is no usable
    // text, send a kind-aware ack so the user knows the bot received
    // something but cannot process it. 5-minute TTL matches the other
    // transient system notices.
    if (!text && message.attachmentKind) {
      const replyOptions = {
        ...(message.replyTarget.replyToMessageId
          ? { replyToMessageId: message.replyTarget.replyToMessageId }
          : {}),
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry
        .sendMessage(
          message.platform,
          message.replyTarget.chatId,
          nonTextMessageAck(message.attachmentKind),
          replyOptions,
        )
        .catch(() => null);
      return;
    }
    if (!text) return;
    const key = botConversationKey(message);
    const current = botConversationQueues.get(key) ?? Promise.resolve();
    const next = current
      .catch(() => {})
      .then(() => (closed ? undefined : processBotIncomingMessage(key, message, text)));
    const tracked = next.finally(() => {
      if (botConversationQueues.get(key) === tracked) botConversationQueues.delete(key);
    });
    botConversationQueues.set(key, tracked);
    await tracked;
  }

  function close(): Promise<void> {
    if (closeTask) return closeTask;
    closed = true;
    closeTask = Promise.allSettled([...activeTasks]).then(() => {
      botConversationQueues.clear();
      botRecentSourceEventKeys.clear();
      botConversationRateBuckets.clear();
    });
    return closeTask;
  }

  function rememberBotSourceEvent(message: BotIncomingMessage): boolean {
    const key = botSourceEventKey(message);
    if (!key) return false;
    const now = Date.now();
    pruneExpiredBotSourceEvents(now);
    if (botRecentSourceEventKeys.has(key)) return true;
    botRecentSourceEventKeys.set(key, now);
    while (botRecentSourceEventKeys.size > BOT_RECENT_SOURCE_EVENT_LIMIT) {
      const oldest = botRecentSourceEventKeys.keys().next().value;
      if (!oldest) break;
      botRecentSourceEventKeys.delete(oldest);
    }
    return false;
  }

  function pruneExpiredBotSourceEvents(now: number): void {
    for (const [key, seenAt] of botRecentSourceEventKeys) {
      if (now - seenAt <= BOT_RECENT_SOURCE_EVENT_TTL_MS) break;
      botRecentSourceEventKeys.delete(key);
    }
  }

  function consumeBotConversationToken(conversationKey: string, now = Date.now()): boolean {
    pruneExpiredBotConversationRateBuckets(now);
    const bucket = botConversationRateBuckets.get(conversationKey) ?? {
      tokens: BOT_CONVERSATION_RATE_BURST,
      updatedAt: now,
    };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = Math.floor(elapsed / BOT_CONVERSATION_RATE_REFILL_MS);
    if (refilled > 0) {
      bucket.tokens = Math.min(BOT_CONVERSATION_RATE_BURST, bucket.tokens + refilled);
      bucket.updatedAt += refilled * BOT_CONVERSATION_RATE_REFILL_MS;
    }
    if (bucket.tokens <= 0) {
      botConversationRateBuckets.set(conversationKey, bucket);
      return false;
    }
    bucket.tokens -= 1;
    botConversationRateBuckets.set(conversationKey, bucket);
    while (botConversationRateBuckets.size > BOT_CONVERSATION_RATE_BUCKET_LIMIT) {
      const oldest = botConversationRateBuckets.keys().next().value;
      if (!oldest) break;
      botConversationRateBuckets.delete(oldest);
    }
    return true;
  }

  function pruneExpiredBotConversationRateBuckets(now: number): void {
    for (const [key, bucket] of botConversationRateBuckets) {
      if (now - bucket.updatedAt > BOT_CONVERSATION_RATE_BUCKET_TTL_MS) {
        botConversationRateBuckets.delete(key);
      }
    }
  }

  async function sendTransientBotNotice(message: BotIncomingMessage, text: string, ttlMs: number): Promise<void> {
    if (closed) return;
    await deps.botRegistry.sendMessage(
      message.platform,
      message.replyTarget.chatId,
      text,
      {
        ...(message.replyTarget.replyToMessageId
          ? { replyToMessageId: message.replyTarget.replyToMessageId }
          : {}),
        ephemeralTtlMs: ttlMs,
      },
    ).catch(() => null);
  }

  async function resolveBotConversationSession(
    conversationKey: string,
    message: BotIncomingMessage,
    noticeTtlMs: number,
  ): Promise<string | undefined> {
    const resolution = await deps.sessions.resolveSession({
      conversationId: conversationKey,
      name: `${botDisplayLabel(message.platform)} 任务`,
      labels: ['bot', message.platform],
    });
    if (resolution.kind === 'permission_refused') {
      await sendBotPermissionRefusal(message, noticeTtlMs);
      return undefined;
    }
    return resolution.sessionId;
  }

  async function processBotIncomingMessage(
    conversationKey: string,
    message: BotIncomingMessage,
    text: string,
  ): Promise<void> {
    if (closed) return;
    let replyStream: BotReplyStream | null = null;
    // PR-BOT-EPHEMERAL-REPLY-0: TTL for system notices (help / reset ack /
    // fallback errors). Five minutes is long enough for the user to read
    // and process the notice on mobile; short enough that bot DMs do not
    // accumulate transient noise after a few weeks of use. The actual
    // agent reply does NOT get this TTL — the answer must stay visible.
    const SYSTEM_NOTICE_TTL_MS = 5 * 60 * 1_000;
    // PR-BOT-PLAINTEXT-HELP-COMMAND-0: DM-only quick "what can I do here?"
    // hint. Lands BEFORE the reset path so a user typing "help" gets a
    // capability list, not a (silent) reset.
    if (isPlaintextHelpCommand({ text, isGroup: message.isGroup })) {
      const replyOptions = {
        ...(message.replyTarget.replyToMessageId
          ? { replyToMessageId: message.replyTarget.replyToMessageId }
          : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      await deps.botRegistry.sendMessage(
        message.platform,
        message.replyTarget.chatId,
        plaintextHelpReply(),
        replyOptions,
      ).catch(() => null);
      return;
    }
    // PR-BOT-PLAINTEXT-RESET-COMMAND-0 (external bot research): in DMs, a bare
    // "restart" / "重置" / etc. drops the conversation/session binding so
    // the next message starts a fresh thread. DM-only because the
    // conversation identity is channel-defined — in a group chat any
    // member would otherwise be able to wipe everyone else's context.
    if (isPlaintextResetCommand({ text, isGroup: message.isGroup })) {
      const had = await deps.sessions.releaseConversation({
        conversationId: conversationKey,
        operationId: botSourceOperationId(message, newId),
      });
      botConversationRateBuckets.delete(conversationKey);
      const replyOptions = {
        ...(message.replyTarget.replyToMessageId
          ? { replyToMessageId: message.replyTarget.replyToMessageId }
          : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      const ack = had
        ? '任务已重置，下一条消息会开新任务。'
        : '当前没有进行中的任务；下一条消息会开新任务。';
      await deps.botRegistry
        .sendMessage(message.platform, message.replyTarget.chatId, ack, replyOptions)
        .catch(() => null);
      return;
    }
    try {
      if (!consumeBotConversationToken(conversationKey)) {
        await sendTransientBotNotice(
          message,
          'Maka 收到的机器人消息过于频繁，请稍后再试。',
          SYSTEM_NOTICE_TTL_MS,
        );
        return;
      }
      const sessionId = await resolveBotConversationSession(
        conversationKey,
        message,
        SYSTEM_NOTICE_TTL_MS,
      );
      if (!sessionId) return;

      const messageId = botSourceOperationId(message, newId);
      const replyOptions = message.replyTarget.replyToMessageId
        ? { replyToMessageId: message.replyTarget.replyToMessageId }
        : undefined;
      replyStream = deps.botRegistry.startReplyStream?.(
        message.platform,
        message.replyTarget.chatId,
        { ...(replyOptions ?? {}), isGroup: message.isGroup, streamId: messageId },
      ) ?? null;
      const turn = deps.sessions.runTurn({
        sessionId,
        messageId,
        text: formatBotMessageForSession({ ...message, text }),
        onReplySnapshot: (snapshot) => replyStream?.update(snapshot),
      });
      // PR-BOT-TYPING-INDICATOR-0 (external bot research): keep "Maka 正在
      // 输入…" visible in the Telegram client while the agent generates
      // its reply. Telegram auto-clears the indicator after ~5 seconds,
      // so we refresh every 4 seconds. The loop is best-effort: every
      // failure is swallowed so a typing-endpoint outage cannot block
      // or corrupt the actual reply path.
      const typingAbort = new AbortController();
      const typingLoop = (async () => {
        // Fire-and-forget first beat so the indicator shows immediately,
        // not 4 seconds in.
        await deps.botRegistry
          .sendTypingIndicator(message.platform, message.replyTarget.chatId)
          .catch(() => false);
        while (!typingAbort.signal.aborted) {
          await new Promise<void>((resolve) => {
            const onAbort = (): void => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              typingAbort.signal.removeEventListener('abort', onAbort);
              resolve();
            }, 4000);
            typingAbort.signal.addEventListener('abort', onAbort, { once: true });
          });
          if (typingAbort.signal.aborted) break;
          await deps.botRegistry
            .sendTypingIndicator(message.platform, message.replyTarget.chatId)
            .catch(() => false);
        }
      })();
      let reply: string;
      try {
        reply = botReply(await turn);
      } finally {
        typingAbort.abort();
        await typingLoop.catch(() => {});
      }
      if (closed) {
        await replyStream?.abort();
        return;
      }
      // PR-BOT-REPLY-TO-MESSAGE-0 (external bot research): thread the bot reply
      // under the originating user message. Group chats with concurrent
      // conversations otherwise visually scramble; even in DMs the threading
      // keeps a long reply attached to the question that produced it. Bot
      // bridge layer drops the field for non-Telegram platforms / multi-chunk
      // continuation pieces.
      if (reply.trim()) {
        // Actual agent reply: NO ephemeral TTL. The answer must stay
        // visible — auto-deleting it would defeat the bot's purpose.
        const sent = replyStream
          ? await replyStream.finish(reply.trim())
          : await deps.botRegistry.sendMessage(
              message.platform,
              message.replyTarget.chatId,
              reply.trim(),
              replyOptions,
            );
        if (!sent) {
          // Fallback transient notice: 5-minute TTL so the chat does
          // not accumulate "delivery failed" markers.
          await deps.botRegistry.sendMessage(
            message.platform,
            message.replyTarget.chatId,
            'Maka 已生成回复，但当前机器人通道暂时无法发送。',
            { ...(replyOptions ?? {}), ephemeralTtlMs: 5 * 60 * 1_000 },
          ).catch(() => null);
        }
      } else {
        await replyStream?.abort();
      }
    } catch (error) {
      await replyStream?.abort().catch(() => {});
      if (closed) return;
      const detail = isSessionWorkspaceUnavailableError(error)
        ? '工作目录不可用，请在桌面端选择有效目录后重试'
        : generalizedErrorMessage(error, '机器人对话处理失败');
      const replyOptions = {
        ...(message.replyTarget.replyToMessageId
          ? { replyToMessageId: message.replyTarget.replyToMessageId }
          : {}),
        // Error notice: same 5-minute TTL as the other transient system
        // notices.
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry.sendMessage(
        message.platform,
        message.replyTarget.chatId,
        `Maka 暂时无法处理这条消息：${detail}`,
        replyOptions,
      ).catch(() => null);
    }
  }

  async function sendBotPermissionRefusal(
    message: BotIncomingMessage,
    noticeTtlMs: number,
  ): Promise<void> {
    await sendTransientBotNotice(
      message,
      'Maka 已拒绝这条机器人消息：绑定任务当前不是只读探索模式，请先在桌面端切回 explore 后再试。',
      noticeTtlMs,
    );
  }

  return { handleBotIncomingMessage, close };
}

function botSourceOperationId(message: BotIncomingMessage, newId: () => string): string {
  const sourceEventKey = botSourceEventKey(message);
  if (!sourceEventKey) return newId();
  // Host message admission is idempotent for this source operation and exact
  // payload, so a reconnect redelivery cannot run the model twice. Reply delivery remains
  // at-least-once: IM send APIs provide no transaction shared with Host state.
  return `bot_${createHash('sha256').update(sourceEventKey, 'utf8').digest('hex')}`;
}

function botReply(result: BotSessionTurnResult): string {
  if (result.kind === 'suspended') {
    return '这条请求需要在 Maka 桌面端审批后才能继续。';
  }
  if (result.kind === 'errored') return `Maka 处理失败：${result.reason}`;
  return result.text;
}
