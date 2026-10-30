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

import { assistantMessageText } from '@maka/core/assistant-card';

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BotChannelSettings, BotProvider } from '@maka/core/bot-chat-settings';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import type { AssistantWebBackend } from './assistant-web-backend.js';

type Delivery = { id: string; text: string; summary?: string; attempts: number; done: boolean; acceptedMessageId?: string; acceptedAt?: number; readState?: 'read' | 'unread' | 'unknown'; checkedAt?: number; error?: string };
type Receipt = {
  version: 1;
  identity: string;
  conversationId: string;
  chatId?: string;
  through: number;
  confirmation: Delivery;
  delivery?: Delivery;
};
export interface AssistantImDeps {
  platform?: BotProvider;
  backend: Pick<AssistantWebBackend, 'state' | 'history' | 'send' | 'close'>;
  readChannel(): Promise<BotChannelSettings>;
  registry: Pick<BotRegistry, 'sendMessage'> & Partial<Pick<BotRegistry, 'sendTypingIndicator' | 'cancelTypingIndicator' | 'getMessageReadStatus'>>;
  statePath: string;
  isActive(): boolean;
  onError(error: unknown): void;
  pollMs?: number;
  retryMs?: number;
}

/** A best-effort transport, not another Agent. Receipts survive restarts;
 * uncertain deliveries count as attempts, so crashes cannot cause endless retries. */
export function createAssistantImBridge(deps: AssistantImDeps) {
  const platform = deps.platform ?? 'wechat';
  const label = platform === 'feishu' ? '飞书' : platform === 'wechat' ? '微信' : platform;
  let closed = false;
  let receipt: Receipt | undefined;
  let loaded = false;
  let initializing: Promise<Receipt> | undefined;
  let polling: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const abort = new AbortController();
  let typingChat: string | undefined;
  let typingAt = 0;
  let typingPoll: Promise<void> | undefined;
  let readPoll: Promise<void> | undefined;
  function tickReadStatus(): Promise<void> {
    if (readPoll) return readPoll;
    readPoll = (async () => {
      const r = receipt, d = r?.delivery;
      if (platform !== 'feishu' || !r || !d?.acceptedMessageId || !d.acceptedAt ||
        !deps.registry.getMessageReadStatus || d.readState === 'read' || closed ||
        Date.now() - d.acceptedAt > 86_400_000 || Date.now() - (d.checkedAt ?? 0) < 30_000) return;
      const c = await valid(r);
      const status = await deps.registry.getMessageReadStatus(platform, d.acceptedMessageId, c.allowedUserIds![0]!);
      if (closed || receipt !== r || r.delivery !== d) return;
      d.readState = status.state;
      d.checkedAt = Date.now();
      await save(r);
    })().catch(() => undefined).finally(() => { readPoll = undefined; });
    return readPoll;
  }
  async function clearTyping() {
    const chat = typingChat;
    typingChat = undefined;
    typingAt = 0;
    if (chat) await deps.registry.cancelTypingIndicator?.(platform, chat).catch(() => false);
  }
  // Presence runs independently from outbound retries and never blocks Inbox admission.
  function tickTyping(): Promise<void> {
    if (typingPoll) return typingPoll;
    typingPoll = (async () => {
      try {
        if (!deps.registry.sendTypingIndicator || closed || !deps.isActive()) return await clearTyping();
        const c = await deps.readChannel();
        if (!c.enabled || (c.messageHandling ?? 'task') !== 'assistant' || c.allowedUserIds?.length !== 1)
          return await clearTyping();
        const state = await deps.backend.state();
        if (!state.working || closed || !deps.isActive()) return await clearTyping();
        const chat = destination(c);
        if (!chat) return await clearTyping();
        if (typingChat !== chat) await clearTyping();
        if (!typingChat || Date.now() - typingAt >= 4000) {
          typingChat = chat;
          typingAt = Date.now();
          await deps.registry.sendTypingIndicator(platform, chat);
        }
      } catch { await clearTyping(); }
    })().finally(() => { typingPoll = undefined; });
    return typingPoll;
  }
  const identity = (c: BotChannelSettings) =>
    createHash('sha256')
      .update(JSON.stringify(platform === 'wechat'
        ? [c.webhookUrl, c.botUserId, c.token, c.allowedUserIds]
        : platform === 'feishu' ? [platform, c.appId, c.appSecret, c.token, c.domain, c.allowedUserIds]
        : [platform, c.webhookUrl, c.appId, c.appSecret, c.botUserId, c.token, c.domain, c.allowedUserIds]))
      .digest('hex');
  function destination(c: BotChannelSettings): string | undefined {
    if (receipt && receipt.identity !== identity(c)) return undefined;
    return receipt?.chatId ?? ((platform === 'wechat' || platform === 'feishu') ? c.allowedUserIds?.[0] : undefined);
  }
  async function channel() {
    if (closed || !deps.isActive()) throw Error('IM assistant transport is inactive');
    const c = await deps.readChannel();
    if ((c.messageHandling ?? 'task') !== 'assistant') throw Error('IM assistant mode is inactive');
    if (!c.enabled || c.allowedUserIds?.length !== 1 || !c.allowedUserIds[0]?.trim())
      throw Error(`请为${label}设置唯一允许的私聊用户，然后发送一条私聊消息。`);
    return c;
  }
  function save(value: Receipt) {
    if (receipt !== value) throw Error('IM binding changed during delivery');
    const body = JSON.stringify(value);
    const next = writes.then(async () => {
      await mkdir(dirname(deps.statePath), { recursive: true });
      const temporary = `${deps.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, deps.statePath);
    });
    writes = next.catch(() => undefined);
    return next;
  }
  async function binding(chatId?: string): Promise<Receipt> {
    if (initializing) return initializing;
    initializing = (async () => {
      const c = await channel();
      const state = await deps.backend.state(); // Also enforces assistant enablement.
      if (!loaded) {
        try {
          const saved = JSON.parse(await readFile(deps.statePath, 'utf8')) as Receipt;
          if (
            saved.version !== 1 ||
            typeof saved.identity !== 'string' ||
            typeof saved.conversationId !== 'string' ||
            !Number.isSafeInteger(saved.through) ||
            saved.through < 0 ||
            !saved.confirmation
          )
            throw Error('Invalid IM delivery receipt');
          receipt = saved;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        loaded = true;
      }
      if (
        !receipt ||
        receipt.identity !== identity(c) ||
        receipt.conversationId !== state.conversationId
      ) {
        receipt = {
          version: 1,
          identity: identity(c),
          conversationId: state.conversationId,
          through: state.revision ?? 0,
          confirmation: {
            id: 'connected',
            text: `已连接 Maka 个人助手，可以在这里继续聊。${label}消息可能投递失败，完整记录可在 Maka 或网页查看。`,
            attempts: 0,
            done: false,
          },
        };
        await save(receipt); // Freeze the initial boundary before admitting any new input.
      }
      if (chatId) {
        if (receipt.chatId && receipt.chatId !== chatId) throw Error('Assistant is bound to a different private conversation');
        if (!receipt.chatId) {
          receipt.chatId = chatId;
          if (platform !== 'wechat' && platform !== 'feishu') receipt.through = state.revision ?? 0;
          await save(receipt);
        }
      }
      return receipt;
    })().finally(() => {
      initializing = undefined;
    });
    return initializing;
  }
  async function valid(r: Receipt) {
    const c = await channel();
    if (identity(c) !== r.identity || receipt !== r) throw Error('IM binding changed');
    const state = await deps.backend.state();
    if (state.conversationId !== r.conversationId || closed || !deps.isActive() || receipt !== r)
      throw Error('Assistant conversation changed or stopped');
    return c;
  }
  async function deliver(r: Receipt, d: Delivery) {
    if (d.done) return;
    while (d.attempts < 2) {
      if (d.attempts) await delay(deps.retryMs ?? 2000, undefined, { signal: abort.signal });
      const c = await valid(r);
      d.attempts++;
      await save(r);
      try {
        const chat = destination(c);
        if (!chat) throw Error('Send a private message first to bind the assistant channel');
        const id = await deps.registry.sendMessage(platform, chat, d.text, { summary: d.summary, clientMessageId: createHash('sha256').update(`${r.identity}:${r.conversationId}:${d.id}`).digest('hex').slice(0, 40) });
        if (!id) throw Error('IM did not accept the message');
        d.acceptedAt = Date.now();
        d.acceptedMessageId = id; // API acknowledgement, not proof of delivery or reading.
        d.done = true;
        delete d.error;
        await save(r);
        return;
      } catch {
        d.error = `${label}投递失败`;
        await save(r);
      }
    }
    d.done = true;
    await save(r);
    deps.onError(new Error(`${label}消息 ${d.id} 投递两次失败，桌面和网页记录保留。`));
  }
  async function runPoll() {
    // Disabled/unpaired channels do not even open the assistant Session.
    const c = await deps.readChannel();
    if ((c.messageHandling ?? 'task') !== 'assistant') {
      // Re-entering assistant mode starts at current history, without backfilling
      // messages generated while another mode was selected.
      receipt = undefined;
      loaded = true;
      return;
    }
    if (!c.enabled || c.allowedUserIds?.length !== 1 || !deps.isActive() || closed) return;
    const r = await binding();
    if (!destination(c)) return;
    await deliver(r, r.confirmation);
    if (((await deps.backend.state()).revision ?? 0) <= r.through) return;
    let cursor: string | null = null;
    do {
      await valid(r);
      const q = new URLSearchParams({ conversationId: r.conversationId, after: String(r.through) });
      if (cursor) q.set('cursor', cursor);
      const page = await deps.backend.history(q);
      for (const message of page.messages) {
        if (message.sequence <= r.through) continue;
        if (message.role === 'assistant') {
          if (r.delivery?.id !== message.id) {
            r.delivery = { id: message.id, text: assistantMessageText(message), summary: message.summary, attempts: 0, done: false };
            await save(r);
          }
          await deliver(r, r.delivery);
        }
        r.through = message.sequence;
        await save(r);
      }
      cursor = page.next;
      if (!cursor && page.through !== null) {
        r.through = Math.max(r.through, page.through);
        await save(r);
      }
    } while (cursor && !closed);
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (!polling)
      polling = runPoll().finally(() => {
        polling = undefined;
      });
    return polling;
  }
  let lastPollError = '';
  const timer = setInterval(() => {
    void tickTyping();
    void tickReadStatus();
    void tick()
      .then(() => {
        lastPollError = '';
      })
      .catch((error: unknown) => {
        const key = error instanceof Error ? error.message : String(error);
        if (key !== lastPollError) deps.onError(error);
        lastPollError = key;
      });
  }, deps.pollMs ?? 2000);
  timer.unref();
  return {
    tick,
    tickTyping,
    tickReadStatus,
    async handle(message: BotIncomingMessage) {
      const c = await channel();
      if (
        message.platform !== platform || !message.chatId.trim() || message.isGroup ||
        message.userId !== c.allowedUserIds![0] ||
        (platform === 'wechat' && message.chatId !== message.userId)
      )
        throw Error(`${label}个人助手只接受绑定用户的私聊。`);
      await binding();
      const r = await binding(message.chatId);
      const id =
        platform + '-' +
        createHash('sha256')
          .update(JSON.stringify([r.identity, message.chatId, message.sourceMessageId]))
          .digest('hex');
      await deps.backend.send({ conversationId: r.conversationId, id, text: message.text });
      void tickTyping();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      abort.abort();
      await readPoll;
      await typingPoll;
      await clearTyping();
      await polling?.catch(() => undefined);
      await initializing?.catch(() => undefined);
      await writes;
      await deps.backend.close();
    },
  };
}
