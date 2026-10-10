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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WORKHUB_COORDINATION_SESSION_ID, type StoredMessage } from '@maka/core/session';
import { generalizedErrorMessageForLocale } from '@maka/core/redaction';
import { formatBotMessageForSession } from '@maka/core/bot-events';
import type { BotMessageHandling } from '@maka/core/bot-chat-settings';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { SESSION_TRANSCRIPT_PAGE_MAX_BYTES, type InteractionPendingSnapshot, type SessionContinuitySnapshot } from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient, DesktopRuntimeHostSession } from './runtime-host-client.js';
import { formatRemoteChoices, parseRemoteChoices } from './workhub-remote-choices.js';

type Source = Pick<BotIncomingMessage, 'platform' | 'chatId' | 'userId' | 'sourceMessageId'>;
interface State {
  version: 1;
  through: number | null;
  turns: Record<string, Source>;
  actions: Record<string, Source>;
  inputs: Record<string, string>;
  replies: Record<string, string>;
  delivered: Record<string, string>;
}
export interface WorkHubRemoteBridge {
  handle(message: BotIncomingMessage, acceptMessage?: () => boolean): Promise<boolean>;
  close(): Promise<void>;
}
interface Deps {
  client: Pick<DesktopRuntimeHostClient, 'openSession' | 'resolveWorkHubCoordinationSession' | 'answerWorkHubCoordination' | 'answerInteraction' | 'queryInteraction' | 'queryTurn' | 'subscribeSessionCatalogChanges'>;
  botRegistry: Pick<BotRegistry, 'sendMessage'>;
  readMode(): Promise<BotMessageHandling>;
  statePath: string;
  isActive?(): boolean;
  onError(error: unknown): void;
}

/** One transport adapter for the canonical WorkHub Session. Routing receipts
 * belong to this Desktop/Host pair; task and interaction authority stays in Host.
 */
export function createWorkHubRemoteBridge(deps: Deps): WorkHubRemoteBridge {
  let state: State = { version: 1, through: null, turns: {}, actions: {}, inputs: {}, replies: {}, delivered: {} };
  let loaded = false;
  let closed = false;
  let session: DesktopRuntimeHostSession | undefined;
  let snapshot: SessionContinuitySnapshot | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = lane.then(action, action);
    lane = next.catch(() => undefined);
    return next;
  };
  const reference = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8);
  const sameChat = (source: Source, message: BotIncomingMessage) => source.platform === message.platform && source.chatId === message.chatId && source.userId === message.userId;
  async function load() {
    if (loaded) return;
    try {
      const value = JSON.parse(await readFile(deps.statePath, 'utf8')) as State;
      if (value.version !== 1 || !value.turns || !value.actions || !value.inputs || !value.replies || !value.delivered || !(value.through === null || Number.isSafeInteger(value.through))) throw new Error('Invalid WorkHub remote routing state');
      state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    loaded = true;
  }
  async function save() {
    await mkdir(dirname(deps.statePath), { recursive: true });
    const temporary = `${deps.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, deps.statePath);
  }
  async function send(source: Source, text: string): Promise<void> {
    if (closed || deps.isActive?.() === false) throw new Error('WorkHub remote transport is inactive');
    const sent = await deps.botRegistry.sendMessage(source.platform, source.chatId, text,
      source.sourceMessageId ? { replyToMessageId: source.sourceMessageId } : undefined);
    if (!sent) throw new Error('WorkHub remote reply delivery failed');
  }
  async function deliver(key: string, source: Source, text: string) {
    const digest = createHash('sha256').update(text).digest('hex');
    if (state.delivered[key] === digest) return;
    await send(source, text);
    state.delivered[key] = digest;
    await save();
  }
  function observe(message: StoredMessage) {
    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') {
      const source = state.turns[message.coordinationTurnId];
      if (source) state.actions[message.actionId] = source;
    }
    if (message.type === 'user' && message.origin?.kind === 'workhub_result') {
      const source = state.actions[message.origin.actionId];
      if (source) state.turns[message.turnId] = source;
    }
    if (message.type === 'assistant' && state.turns[message.turnId] && message.text.trim()) state.replies[message.turnId] = message.text;
  }
  async function dispatch() {
    const first = Object.entries(state.inputs)[0];
    if (!first || closed) return;
    const [turnId, text] = first;
    try {
      await deps.client.answerWorkHubCoordination({ turnId, text });
      delete state.inputs[turnId];
      await save();
    } catch (error) {
      if (error instanceof RuntimeHostOperationError) {
        if (error.code === 'session_busy') return;
        if (error.code !== 'outcome_unknown' && error.code !== 'commit_outcome_unknown') {
          await deliver(`admission:${turnId}`, state.turns[turnId]!, generalizedErrorMessageForLocale(error, 'WorkHub 无法开始处理这条消息', 'zh-CN'));
          delete state.inputs[turnId];
          await save();
          return;
        }
      }
      // A lost response is not a rejection. Retry the same durable Turn ID;
      // Host admission deduplicates it even if the first request committed.
      deps.onError(error);
    }
  }
  async function reconcile() {
    if (!session || closed || deps.isActive?.() === false) return;
    const through = session.transcriptWatermark;
    if (through !== null && (state.through === null || through > state.through)) {
      let cursor: string | null = null;
      do {
        const page = await session.loadTranscriptPage({ direction: 'newer', throughSequence: through,
          anchorSequence: state.through, cursor, maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES });
        const decoded = await session.decodeTranscriptPage(page);
        for (const { message } of decoded.messages) observe(message);
        cursor = decoded.nextCursor;
      } while (cursor !== null);
      state.through = through;
      await save();
    }
    for (const [turnId, text] of Object.entries(state.replies)) {
      const turn = await deps.client.queryTurn({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId });
      if (turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled') continue;
      try {
        await deliver(`reply:${turnId}`, state.turns[turnId]!, text);
        delete state.replies[turnId];
        await save();
      } catch (error) { deps.onError(error); }
    }
    for (const interaction of snapshot?.interactions.pending ?? []) {
      const source = state.turns[interaction.turnId];
      if (!source) continue;
      const text = formatRemoteChoices(interaction.request, reference(interaction.interactionId))
        ?? '这条 WorkHub 请求需要在 Maka 桌面端处理，完成后会继续回复。';
      await deliver(`question:${interaction.interactionId}`, source, text).catch(deps.onError);
    }
    await dispatch();
    const turn = snapshot?.rootTurn;
    if (turn && (turn.status === 'failed' || turn.status === 'cancelled') && state.turns[turn.turnId]) {
      await deliver(`failure:${turn.turnId}`, state.turns[turn.turnId]!, turn.status === 'failed' ? `WorkHub 处理失败：${turn.failureClass}` : 'WorkHub 本次处理已取消。');
    }
  }
  async function connect() {
    await load();
    if (session || closed || deps.isActive?.() === false) return;
    const opened = await deps.client.openSession(WORKHUB_COORDINATION_SESSION_ID);
    session = opened;
    snapshot = opened.snapshot;
    void (async () => {
      try {
        for await (const frame of opened.events) {
          if (closed) break;
          if (frame.kind === 'subscription.closed') break;
          if (frame.kind === 'subscription.session_projection') snapshot = frame.snapshot;
          if (frame.kind === 'subscription.session_projection' || frame.kind === 'subscription.transcript_advanced')
            await serial(reconcile);
        }
      } catch (error) { if (!closed) deps.onError(error); }
      finally {
        if (session === opened) session = undefined;
        await opened.close().catch(deps.onError);
      }
    })();
    await opened.ready();
    await reconcile();
  }
  function pendingFor(message: BotIncomingMessage): InteractionPendingSnapshot[] {
    return (snapshot?.interactions.pending ?? []).filter((item) => {
      const source = state.turns[item.turnId];
      return source && sameChat(source, message) && formatRemoteChoices(item.request, reference(item.interactionId));
    });
  }
  const unsubscribe = deps.client.subscribeSessionCatalogChanges((frame) => {
    if (frame.sessionId !== WORKHUB_COORDINATION_SESSION_ID || closed) return;
    void serial(async () => {
      await load();
      if (Object.keys(state.turns).length) { await connect(); await reconcile(); }
    }).catch(deps.onError);
  });
  // Recover known routing receipts without creating or configuring WorkHub.
  void serial(async () => { await load(); if (Object.keys(state.turns).length) await connect(); }).catch(deps.onError);
  const retry = setInterval(() => {
    if (closed) return;
    void serial(async () => { await load(); if (Object.keys(state.turns).length) { await connect(); await reconcile(); } }).catch(deps.onError);
  }, 5000);
  retry.unref();
  return {
    handle: (message, acceptMessage) => serial(async () => {
      if (closed || deps.isActive?.() === false) return true;
      await load();
      const enabled = await deps.readMode() === 'workhub';
      if (!enabled && !session) return false;
      if (enabled) await deps.client.resolveWorkHubCoordinationSession();
      await connect();
      const tagged = message.text.trim().match(/^#([a-f0-9]{8})\s+(.+)$/is);
      const pending = pendingFor(message).filter((item) => !tagged || reference(item.interactionId) === tagged[1]!.toLowerCase());
      if ((enabled || pending.length) && acceptMessage && !acceptMessage()) {
        await send(message, 'Maka 收到的机器人消息过于频繁，请稍后再试。');
        return true;
      }
      const text = tagged?.[2] ?? message.text;
      if (!enabled && !pending.length) return false;
      if (tagged && !pending.length) {
        await send(message, '这组问题已结束或不属于当前聊天，请根据最新问题重新回答。');
        return true;
      }
      if (pending.length) {
        const parsed = pending.map((item) => ({ item, result: parseRemoteChoices(item.request, text) }));
        if (parsed.some(({ result }) => result.kind !== 'text')) {
          if (pending.length > 1) {
            await send(message, '当前有多组问题，请在选择前加上问题编号，例如 #编号 ACC。');
            return true;
          }
          const { item, result } = parsed[0]!;
          if (result.kind === 'invalid') { await send(message, result.message); return true; }
          if (result.kind === 'answer') {
            const current = await deps.client.queryInteraction({ sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: item.interactionId });
            if (current.status !== 'pending') { await send(message, '这组问题已经回答或失效，请查看最新回复。'); return true; }
            await deps.client.answerInteraction({ sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: item.interactionId, answer: result.answer });
            return true;
          }
        }
      }
      if (!enabled) return false;
      if (Object.keys(state.inputs).length >= 100) {
        await send(message, 'WorkHub 等待处理的消息过多，请稍后再试。');
        return true;
      }
      const turnId = message.sourceMessageId
        ? `whr_${createHash('sha256').update(JSON.stringify([message.platform, message.chatId, message.sourceMessageId])).digest('hex').slice(0, 48)}`
        : randomUUID();
      if (state.turns[turnId]) return true;
      state.turns[turnId] = { platform: message.platform, chatId: message.chatId, userId: message.userId, sourceMessageId: message.sourceMessageId };
      state.inputs[turnId] = formatBotMessageForSession(message);
      await save();
      await dispatch();
      if (state.inputs[turnId]) await send(message, '消息已收到，WorkHub 会在当前处理结束后继续。若正在等待选择，请先回答上面的选项。');
      return true;
    }),
    async close() {
      closed = true;
      unsubscribe();
      clearInterval(retry);
      await session?.close();
      await lane;
    },
  };
}
