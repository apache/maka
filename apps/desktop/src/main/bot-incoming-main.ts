import { randomUUID } from 'node:crypto';
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
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import type { BotSessionAdapter, BotSessionTurnResult } from './bot-session-adapter.js';
import { isBotSessionUnavailableError } from './bot-session-adapter.js';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

const BOT_RECENT_SOURCE_EVENT_LIMIT = 1_000;
const BOT_RECENT_SOURCE_EVENT_TTL_MS = 60 * 60 * 1_000;
const BOT_CONVERSATION_SESSION_LIMIT = 500;
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
  invalidateSessionBindings(sessionId: string): void;
  close(): Promise<void>;
}

interface BotIncomingMainServiceDeps {
  sessions: BotSessionAdapter;
  botRegistry: BotRegistry;
}

export function createBotIncomingMainService(deps: BotIncomingMainServiceDeps): BotIncomingMainService {
  const botConversationSessions = new Map<string, string>();
  const botConversationQueues = new Map<string, Promise<void>>();
  const botRecentSourceEventKeys = new Map<string, number>();
  const botConversationRateBuckets = new Map<string, BotConversationRateBucket>();
  const activeTasks = new Set<Promise<void>>();
  let closed = false;
  let closeTask: Promise<void> | undefined;

  function invalidateSessionBindings(sessionId: string): void {
    for (const [conversationKey, boundSessionId] of botConversationSessions) {
      if (boundSessionId !== sessionId) continue;
      botConversationSessions.delete(conversationKey);
      botConversationRateBuckets.delete(conversationKey);
    }
  }

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
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry
        .sendMessage(message.platform, message.chatId, nonTextMessageAck(message.attachmentKind), replyOptions)
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
      botConversationSessions.clear();
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
      message.chatId,
      text,
      {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: ttlMs,
      },
    ).catch(() => null);
  }

  async function createBotConversationSession(
    conversationKey: string,
    message: BotIncomingMessage,
    noticeTtlMs: number,
  ): Promise<string | undefined> {
    if (botConversationSessions.size >= BOT_CONVERSATION_SESSION_LIMIT) {
      await sendTransientBotNotice(message, 'Maka 当前机器人会话数量已达上限，请重置或清理旧会话后再试。', noticeTtlMs);
      return undefined;
    }
    if (!consumeBotConversationToken(conversationKey)) {
      await sendTransientBotNotice(message, 'Maka 收到的机器人消息过于频繁，请稍后再试。', noticeTtlMs);
      return undefined;
    }
    const sessionId = await deps.sessions.createSession({
      name: `${botDisplayLabel(message.platform)} 对话`,
      labels: ['bot', message.platform],
    });
    botConversationSessions.set(conversationKey, sessionId);
    return sessionId;
  }

  async function processBotIncomingMessage(
    conversationKey: string,
    message: BotIncomingMessage,
    text: string,
  ): Promise<void> {
    if (closed) return;
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
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      await deps.botRegistry.sendMessage(
        message.platform,
        message.chatId,
        plaintextHelpReply(),
        replyOptions,
      ).catch(() => null);
      return;
    }
    // PR-BOT-PLAINTEXT-RESET-COMMAND-0 (external bot research): in DMs, a bare
    // "restart" / "重置" / etc. drops the conversation/session binding so
    // the next message starts a fresh thread. DM-only because the
    // conversation key is `${platform}:${chatId}` — in a group chat any
    // member would otherwise be able to wipe everyone else's context.
    if (isPlaintextResetCommand({ text, isGroup: message.isGroup })) {
      const had = botConversationSessions.delete(conversationKey);
      botConversationRateBuckets.delete(conversationKey);
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      const ack = had
        ? '会话已重置，下一条消息会开新对话。'
        : '当前没有进行中的对话；下一条消息会开新对话。';
      await deps.botRegistry.sendMessage(message.platform, message.chatId, ack, replyOptions).catch(() => null);
      return;
    }
    let sessionId = botConversationSessions.get(conversationKey);
    try {
      if (!sessionId) {
        sessionId = await createBotConversationSession(
          conversationKey,
          message,
          SYSTEM_NOTICE_TTL_MS,
        );
        if (!sessionId) return;
      } else {
        let rebound = false;
        try {
          const permissionModeOk = await ensureBotSessionExploreMode(
            sessionId,
            message,
            SYSTEM_NOTICE_TTL_MS,
          );
          if (!permissionModeOk) return;
        } catch (error) {
          if (!isBotSessionUnavailableError(error)) throw error;
          invalidateSessionBindings(sessionId);
          sessionId = await createBotConversationSession(
            conversationKey,
            message,
            SYSTEM_NOTICE_TTL_MS,
          );
          if (!sessionId) return;
          rebound = true;
        }
        if (!rebound && !consumeBotConversationToken(conversationKey)) {
          await sendTransientBotNotice(
            message,
            'Maka 收到的机器人消息过于频繁，请稍后再试。',
            SYSTEM_NOTICE_TTL_MS,
          );
          return;
        }
      }

      const turnId = randomUUID();
      const turn = deps.sessions.runTurn({
        sessionId,
        turnId,
        text: formatBotMessageForSession({ ...message, text }),
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
        await deps.botRegistry.sendTypingIndicator(message.platform, message.chatId).catch(() => false);
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
          await deps.botRegistry.sendTypingIndicator(message.platform, message.chatId).catch(() => false);
        }
      })();
      let reply: string;
      try {
        reply = botReply(await turn);
      } finally {
        typingAbort.abort();
        await typingLoop.catch(() => {});
      }
      if (closed) return;
      // PR-BOT-REPLY-TO-MESSAGE-0 (external bot research): thread the bot reply
      // under the originating user message. Group chats with concurrent
      // conversations otherwise visually scramble; even in DMs the threading
      // keeps a long reply attached to the question that produced it. Bot
      // bridge layer drops the field for non-Telegram platforms / multi-chunk
      // continuation pieces.
      const replyOptions = message.sourceMessageId
        ? { replyToMessageId: message.sourceMessageId }
        : undefined;
      if (reply.trim()) {
        // Actual agent reply: NO ephemeral TTL. The answer must stay
        // visible — auto-deleting it would defeat the bot's purpose.
        const sent = await deps.botRegistry.sendMessage(message.platform, message.chatId, reply.trim(), replyOptions);
        if (!sent) {
          // Fallback transient notice: 5-minute TTL so the chat does
          // not accumulate "delivery failed" markers.
          await deps.botRegistry.sendMessage(
            message.platform,
            message.chatId,
            'Maka 已生成回复，但当前机器人通道暂时无法发送。',
            { ...(replyOptions ?? {}), ephemeralTtlMs: 5 * 60 * 1_000 },
          ).catch(() => null);
        }
      }
    } catch (error) {
      if (closed) return;
      const detail = isSessionWorkspaceUnavailableError(error)
        ? '工作目录不可用，请在桌面端选择有效目录后重试'
        : generalizedErrorMessage(error, '机器人对话处理失败');
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        // Error notice: same 5-minute TTL as the other transient system
        // notices.
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry.sendMessage(
        message.platform,
        message.chatId,
        `Maka 暂时无法处理这条消息：${detail}`,
        replyOptions,
      ).catch(() => null);
    }
  }

  async function ensureBotSessionExploreMode(
    sessionId: string,
    message: BotIncomingMessage,
    noticeTtlMs: number,
  ): Promise<boolean> {
    if ((await deps.sessions.prepareSession(sessionId)) === 'ready') return true;
    await sendTransientBotNotice(
      message,
      'Maka 已拒绝这条机器人消息：绑定会话当前不是只读探索模式，请先在桌面端切回 explore 后再试。',
      noticeTtlMs,
    );
    return false;
  }

  return { handleBotIncomingMessage, invalidateSessionBindings, close };
}

function botReply(result: BotSessionTurnResult): string {
  if (result.kind === 'suspended') {
    return '这条请求需要在 Maka 桌面端审批后才能继续。';
  }
  if (result.kind === 'errored') return `Maka 处理失败：${result.reason}`;
  return result.text;
}
