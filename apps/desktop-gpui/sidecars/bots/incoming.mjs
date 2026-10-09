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

// Chat to Session routing for incoming bot messages.
//
// A port of `createBotIncomingMainService` in Maka Desktop's
// apps/desktop/src/main/bot-incoming-main.ts, with the same limits and the
// same chat copy. Desktop keeps one of these per Runtime Host connection
// (`runtime-host-desktop-candidate.ts`), so its chat bindings live in memory
// and start over with the next connection; `host-link.mjs` does the same.
//
// The Maka helpers come in through `maka` (see `maka.mjs`) and the clock and
// id source through `now` and `newId`, so the tests can drive the rate limit
// without waiting; nothing else differs from Desktop.

import { randomUUID } from 'node:crypto';
import { isBotSessionUnavailableError } from './session-adapter.mjs';

export const BOT_RECENT_SOURCE_EVENT_LIMIT = 1_000;
export const BOT_RECENT_SOURCE_EVENT_TTL_MS = 60 * 60 * 1_000;
export const BOT_CONVERSATION_SESSION_LIMIT = 500;
export const BOT_CONVERSATION_RATE_BURST = 8;
export const BOT_CONVERSATION_RATE_REFILL_MS = 5_000;
export const BOT_CONVERSATION_RATE_BUCKET_TTL_MS = 60 * 60 * 1_000;
export const BOT_CONVERSATION_RATE_BUCKET_LIMIT = 1_000;

/** `SESSION_WORKSPACE_UNAVAILABLE_CODE` in apps/desktop/src/main/project-context-root.ts. */
const SESSION_WORKSPACE_UNAVAILABLE_CODE = 'SESSION_WORKSPACE_UNAVAILABLE';

/** `isSessionWorkspaceUnavailableError` in apps/desktop/src/main/project-context-root.ts. */
export function isSessionWorkspaceUnavailableError(error) {
  if (!error || typeof error !== 'object') return false;
  return (
    error.code === SESSION_WORKSPACE_UNAVAILABLE_CODE ||
    (typeof error.message === 'string' &&
      error.message.includes(`${SESSION_WORKSPACE_UNAVAILABLE_CODE}:`))
  );
}

/**
 * @param {object} deps
 * @param {object} deps.sessions a `BotSessionAdapter` (`session-adapter.mjs`)
 * @param {object} deps.botRegistry the `BotRegistry` of `@maka/runtime/bots`
 * @param {object} deps.maka `{ botEvents, redaction }` from `loadMaka`
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 */
export function createBotIncomingService(deps) {
  const {
    botConversationKey,
    botDisplayLabel,
    botSourceEventKey,
    formatBotMessageForSession,
    isPlaintextHelpCommand,
    isPlaintextResetCommand,
    nonTextMessageAck,
    plaintextHelpReply,
  } = deps.maka.botEvents;
  const { generalizedErrorMessageForLocale } = deps.maka.redaction;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const botConversationSessions = new Map();
  const botConversationQueues = new Map();
  const botRecentSourceEventKeys = new Map();
  const botConversationRateBuckets = new Map();
  const activeTasks = new Set();
  let closed = false;
  let closeTask;

  function invalidateSessionBindings(sessionId) {
    for (const [conversationKey, boundSessionId] of botConversationSessions) {
      if (boundSessionId !== sessionId) continue;
      botConversationSessions.delete(conversationKey);
      botConversationRateBuckets.delete(conversationKey);
    }
  }

  function handleBotIncomingMessage(message) {
    if (closed) return Promise.resolve();
    const task = handleAcceptedBotIncomingMessage(message);
    const tracked = task.finally(() => activeTasks.delete(tracked));
    activeTasks.add(tracked);
    return tracked;
  }

  async function handleAcceptedBotIncomingMessage(message) {
    if (rememberBotSourceEvent(message)) return;
    const text = message.text.trim();
    // A photo, voice message or sticker without a caption gets a kind-aware
    // receipt instead of silence (PR-BOT-NON-TEXT-MESSAGE-ACK-0).
    if (!text && message.attachmentKind) {
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry
        .sendMessage(
          message.platform,
          message.chatId,
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

  function close() {
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

  function rememberBotSourceEvent(message) {
    const key = botSourceEventKey(message);
    if (!key) return false;
    const seenNow = now();
    pruneExpiredBotSourceEvents(seenNow);
    if (botRecentSourceEventKeys.has(key)) return true;
    botRecentSourceEventKeys.set(key, seenNow);
    while (botRecentSourceEventKeys.size > BOT_RECENT_SOURCE_EVENT_LIMIT) {
      const oldest = botRecentSourceEventKeys.keys().next().value;
      if (!oldest) break;
      botRecentSourceEventKeys.delete(oldest);
    }
    return false;
  }

  function pruneExpiredBotSourceEvents(at) {
    for (const [key, seenAt] of botRecentSourceEventKeys) {
      if (at - seenAt <= BOT_RECENT_SOURCE_EVENT_TTL_MS) break;
      botRecentSourceEventKeys.delete(key);
    }
  }

  function consumeBotConversationToken(conversationKey, at = now()) {
    pruneExpiredBotConversationRateBuckets(at);
    const bucket = botConversationRateBuckets.get(conversationKey) ?? {
      tokens: BOT_CONVERSATION_RATE_BURST,
      updatedAt: at,
    };
    const elapsed = Math.max(0, at - bucket.updatedAt);
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

  function pruneExpiredBotConversationRateBuckets(at) {
    for (const [key, bucket] of botConversationRateBuckets) {
      if (at - bucket.updatedAt > BOT_CONVERSATION_RATE_BUCKET_TTL_MS) {
        botConversationRateBuckets.delete(key);
      }
    }
  }

  // bot-channel notices follow the bot audience language; localization tracked under #2672
  async function sendTransientBotNotice(message, text, ttlMs) {
    if (closed) return;
    await deps.botRegistry
      .sendMessage(message.platform, message.chatId, text, {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: ttlMs,
      })
      .catch(() => null);
  }

  async function createBotConversationSession(conversationKey, message, noticeTtlMs) {
    if (botConversationSessions.size >= BOT_CONVERSATION_SESSION_LIMIT) {
      await sendTransientBotNotice(
        message,
        'Maka 当前机器人任务数量已达上限，请重置或清理旧任务后再试。',
        noticeTtlMs,
      );
      return undefined;
    }
    if (!consumeBotConversationToken(conversationKey)) {
      await sendTransientBotNotice(message, 'Maka 收到的机器人消息过于频繁，请稍后再试。', noticeTtlMs);
      return undefined;
    }
    const sessionId = await deps.sessions.createSession({
      name: `${botDisplayLabel(message.platform)} 任务`,
      labels: ['bot', message.platform],
    });
    botConversationSessions.set(conversationKey, sessionId);
    return sessionId;
  }

  async function processBotIncomingMessage(conversationKey, message, text) {
    if (closed) return;
    let replyStream = null;
    // System notices (help, reset receipt, fallback errors) delete themselves
    // after five minutes; the agent's reply never does
    // (PR-BOT-EPHEMERAL-REPLY-0).
    const SYSTEM_NOTICE_TTL_MS = 5 * 60 * 1_000;
    // "help" in a direct chat lists what the bot can do, before the reset
    // check (PR-BOT-PLAINTEXT-HELP-COMMAND-0).
    if (isPlaintextHelpCommand({ text, isGroup: message.isGroup })) {
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      await deps.botRegistry
        .sendMessage(message.platform, message.chatId, plaintextHelpReply(), replyOptions)
        .catch(() => null);
      return;
    }
    // "restart" / "重置" in a direct chat drops the binding so the next message
    // starts a new Session. Direct chats only: a group shares one conversation
    // key, and one member must not reset everyone's context
    // (PR-BOT-PLAINTEXT-RESET-COMMAND-0).
    if (isPlaintextResetCommand({ text, isGroup: message.isGroup })) {
      const had = botConversationSessions.delete(conversationKey);
      botConversationRateBuckets.delete(conversationKey);
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: SYSTEM_NOTICE_TTL_MS,
      };
      const ack = had
        ? '任务已重置，下一条消息会开新任务。'
        : '当前没有进行中的任务；下一条消息会开新任务。';
      await deps.botRegistry
        .sendMessage(message.platform, message.chatId, ack, replyOptions)
        .catch(() => null);
      return;
    }
    let sessionId = botConversationSessions.get(conversationKey);
    try {
      if (!sessionId) {
        sessionId = await createBotConversationSession(conversationKey, message, SYSTEM_NOTICE_TTL_MS);
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

      const turnId = newId();
      const replyOptions = message.sourceMessageId
        ? { replyToMessageId: message.sourceMessageId }
        : undefined;
      replyStream =
        deps.botRegistry.startReplyStream?.(message.platform, message.chatId, {
          ...(replyOptions ?? {}),
          isGroup: message.isGroup,
          streamId: turnId,
        }) ?? null;
      const turn = deps.sessions.runTurn({
        sessionId,
        turnId,
        text: formatBotMessageForSession({ ...message, text }),
        onReplySnapshot: (snapshot) => replyStream?.update(snapshot),
      });
      // Keeps the typing indicator up while the reply is generated: Telegram
      // clears it after about five seconds, so it is sent every four. Every
      // failure is swallowed; typing must never block the reply
      // (PR-BOT-TYPING-INDICATOR-0).
      const typingAbort = new AbortController();
      const typingLoop = (async () => {
        await deps.botRegistry.sendTypingIndicator(message.platform, message.chatId).catch(() => false);
        while (!typingAbort.signal.aborted) {
          await new Promise((resolve) => {
            const onAbort = () => {
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
      let reply;
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
      // The reply threads under the message that asked for it
      // (PR-BOT-REPLY-TO-MESSAGE-0), and it has no expiry: the answer must
      // stay visible.
      if (reply.trim()) {
        const sent = replyStream
          ? await replyStream.finish(reply.trim())
          : await deps.botRegistry.sendMessage(
              message.platform,
              message.chatId,
              reply.trim(),
              replyOptions,
            );
        if (!sent) {
          await deps.botRegistry
            .sendMessage(
              message.platform,
              message.chatId,
              'Maka 已生成回复，但当前机器人通道暂时无法发送。',
              { ...(replyOptions ?? {}), ephemeralTtlMs: 5 * 60 * 1_000 },
            )
            .catch(() => null);
        }
      } else {
        await replyStream?.abort();
      }
    } catch (error) {
      await replyStream?.abort().catch(() => {});
      if (closed) return;
      const detail = isSessionWorkspaceUnavailableError(error)
        ? '工作目录不可用，请在桌面端选择有效目录后重试'
        : generalizedErrorMessageForLocale(error, '机器人对话处理失败', 'zh-CN');
      const replyOptions = {
        ...(message.sourceMessageId ? { replyToMessageId: message.sourceMessageId } : {}),
        ephemeralTtlMs: 5 * 60 * 1_000,
      };
      await deps.botRegistry
        .sendMessage(
          message.platform,
          message.chatId,
          `Maka 暂时无法处理这条消息：${detail}`,
          replyOptions,
        )
        .catch(() => null);
    }
  }

  async function ensureBotSessionExploreMode(sessionId, message, noticeTtlMs) {
    if ((await deps.sessions.prepareSession(sessionId)) === 'ready') return true;
    await sendTransientBotNotice(
      message,
      'Maka 已拒绝这条机器人消息：绑定任务当前不是只读探索模式，请先在桌面端切回 explore 后再试。',
      noticeTtlMs,
    );
    return false;
  }

  return { handleBotIncomingMessage, invalidateSessionBindings, close };
}

// bot-channel notices follow the bot audience language; localization tracked under #2672
function botReply(result) {
  if (result.kind === 'suspended') {
    return '这条请求需要在 Maka 桌面端审批后才能继续。';
  }
  if (result.kind === 'errored') return `Maka 处理失败：${result.reason}`;
  return result.text;
}
