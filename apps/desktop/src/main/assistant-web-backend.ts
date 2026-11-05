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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { StoredMessage } from '@maka/core/session';
import {
  assistantAvatarSchema,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostClient, DesktopRuntimeHostSession } from './runtime-host-client.js';

import type { WebMessage, WebState, WebHistory } from '../shared/assistant-web.js';

export class AssistantWebError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AssistantWebBackend {
  state(): Promise<WebState>;
  avatarImage(conversationId: string, id: string): Promise<{ bytes: Buffer; mimeType: string }>;
  history(query: URLSearchParams): Promise<WebHistory>;
  send(input: { conversationId: string; id: string; text: string }): Promise<void>;
  cardAction(input: { conversationId: string; cardId: string; actionKey?: string }): Promise<{ selectedKey: string | null }>;
  close(): Promise<void>;
}
type Client = Pick<
  DesktopRuntimeHostClient,
  'request' | 'openSession' | 'submitMessage' | 'rootId'
>;
interface Target {
  client: Client;
  sessionId: string;
  conversationId: string;
  working: boolean;
}
interface Cursor {
  subscriptionId: string;
  conversationId: string;
  direction: 'older' | 'newer';
  through: number | null;
  after: number | null;
  cursor: string;
}

export function visibleWebMessage(
  message: StoredMessage,
  sequence: number,
): WebMessage | undefined {
  if (message.type === 'user' && !message.origin)
    return {
      id: message.id,
      sequence,
      role: 'user',
      text: message.displayText ?? message.text,
      at: message.ts,
    };
  if (message.type === 'assistant')
    return {
      id: message.id,
      sequence,
      role: 'assistant',
      text: message.text,
      summary: message.summary,
      card: message.card,
      at: message.ts,
    };
  return undefined;
}

/** A transport for the existing owner conversation; never creates a Bot or wakes a model on reads. */
export function createAssistantWebBackend(
  resolveClient: () => Client | undefined,
): AssistantWebBackend {
  const key = randomBytes(32);
  let observed: { target: Target; session: DesktopRuntimeHostSession } | undefined;
  let opening: Promise<void> | undefined;
  let closed = false;
  let imageCache:
    | {
        client: Client;
        sessionId: string;
        id: string;
        value: Promise<{ bytes: Buffer; mimeType: string }>;
      }
    | undefined;
  async function avatar(client: Client) {
    const result = (
      await client.request('personal-assistant.call', { method: 'assistant.avatar', input: {} })
    ).value as { avatar: unknown };
    return assistantAvatarSchema.parse(result.avatar);
  }
  async function target(): Promise<Target> {
    if (closed) throw new AssistantWebError(503, '网页聊天已关闭');
    const client = resolveClient();
    if (!client) throw new AssistantWebError(503, 'Maka 尚未连接，请在电脑上打开 Maka');
    const enablement = (
      await client.request('personal-assistant.call', { method: 'assistant.enablement', input: {} })
    ).value as { enabled?: boolean };
    if (!enablement.enabled) throw new AssistantWebError(409, '请先在 Maka 设置中启用个人助手');
    const binding = (
      await client.request('personal-assistant.call', { method: 'assistant.binding', input: {} })
    ).value as {
      state?: { sessionId?: string };
      bot?: { working?: boolean };
    };
    const sessionId = binding.state?.sessionId;
    if (!sessionId) throw new AssistantWebError(409, '请先在电脑上打开一次个人助手');
    return { client, sessionId, conversationId: '', working: binding.bot?.working === true };
  }
  async function connect(): Promise<Target> {
    const next = await target();
    if (opening) await opening;
    if (
      !observed ||
      observed.target.client !== next.client ||
      observed.target.sessionId !== next.sessionId ||
      observed.session.deathCause
    ) {
      opening = (async () => {
        const old = observed;
        observed = undefined;
        await old?.session.close();
        const session = await next.client.openSession(next.sessionId);
        if (closed) {
          await session.close();
          throw new AssistantWebError(503, '网页聊天已关闭');
        }
        next.conversationId = `${next.client.rootId}:${next.sessionId}`;
        const current = { target: next, session };
        observed = current;
        void (async () => {
          try {
            for await (const frame of session.events) {
              if (frame.kind === 'subscription.closed') break;
            }
          } catch {
            /* The next check reconnects, with history filling any missed events. */
          } finally {
            if (observed === current) observed = undefined;
            await session.close().catch(() => {});
          }
        })();
        await session.ready();
      })().finally(() => {
        opening = undefined;
      });
      await opening;
    }
    if (!observed) throw new AssistantWebError(503, '助手连接已断开，请重试');
    return { ...observed.target, working: next.working };
  }
  function sign(value: Cursor) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  }
  function decode(value: string): Cursor {
    if (value.length > 4096) throw new AssistantWebError(400, '无效的历史游标');
    const [body, signature] = value.split('.');
    const expected = createHmac('sha256', key)
      .update(body ?? '')
      .digest();
    const supplied = Buffer.from(signature ?? '', 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new AssistantWebError(409, '历史游标已失效，请刷新页面');
    return JSON.parse(Buffer.from(body!, 'base64url').toString()) as Cursor;
  }
  return {
    async state() {
      const t = await connect();
      const currentAvatar = await avatar(t.client);
      return {
        avatar: {
          emoji: currentAvatar.emoji,
          background: currentAvatar.background,
          imageUrl: currentAvatar.image
            ? `/api/avatar?conversationId=${encodeURIComponent(t.conversationId)}&id=${currentAvatar.image.id}`
            : undefined,
        },
        conversationId: t.conversationId,
        working: t.working,
        revision: observed!.session.transcriptWatermark,
      };
    },
    async avatarImage(conversationId, id) {
      const t = await connect();
      if (t.conversationId !== conversationId) throw new AssistantWebError(409, '助手会话已变更');
      const metadata = (await avatar(t.client)).image;
      if (!metadata || metadata.id !== id) throw new AssistantWebError(404, '头像已变更');
      if (
        imageCache?.client === t.client &&
        imageCache.sessionId === t.sessionId &&
        imageCache.id === id
      )
        return imageCache.value;
      const value = (async () => {
        let data = '';
        while (data.length < metadata.length) {
          const chunk = (
            await t.client.request('personal-assistant.call', {
              method: 'assistant.avatar-image',
              input: { id, offset: data.length },
            })
          ).value as { id: string; offset: number; data: string };
          if (
            chunk.id !== id ||
            chunk.offset !== data.length ||
            typeof chunk.data !== 'string' ||
            !chunk.data.length ||
            data.length + chunk.data.length > metadata.length
          )
            throw new Error('Invalid avatar image chunk');
          data += chunk.data;
        }
        const bytes = Buffer.from(data, 'base64');
        if (createHash('sha256').update(bytes).digest('hex') !== id)
          throw new Error('Invalid avatar image digest');
        return { bytes, mimeType: metadata.mimeType };
      })();
      const entry = { client: t.client, sessionId: t.sessionId, id, value };
      imageCache = entry;
      void value.catch(() => {
        if (imageCache === entry) imageCache = undefined;
      });
      return value;
    },
    async history(query) {
      const t = await connect();
      const supplied = query.get('conversationId');
      if (supplied && supplied !== t.conversationId)
        throw new AssistantWebError(409, '助手会话已变更，请刷新页面');
      const session = observed!.session;
      let direction: 'older' | 'newer' = query.has('after') ? 'newer' : 'older';
      let after = query.has('after') ? Number(query.get('after')) : null;
      if (after !== null && (!Number.isSafeInteger(after) || after < 0))
        throw new AssistantWebError(400, '无效的消息位置');
      let through = session.transcriptWatermark;
      let cursor: string | null = null;
      if (query.has('cursor')) {
        const parsed = decode(query.get('cursor')!);
        if (
          parsed.conversationId !== t.conversationId ||
          parsed.subscriptionId !== session.subscriptionId
        )
          throw new AssistantWebError(409, '助手会话已变更，请刷新页面');
        ({ direction, after, through, cursor } = parsed);
      }
      const page = await session.loadTranscriptPage({
        direction,
        throughSequence: through,
        anchorSequence: cursor ? null : after,
        cursor,
        maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      });
      const decoded = await session.decodeTranscriptPage(page);
      const messages = decoded.messages.flatMap(({ message, identity }) => {
        const visible = visibleWebMessage(message, identity);
        return visible ? [visible] : [];
      });
      return {
        conversationId: t.conversationId,
        messages,
        through: page.throughSequence,
        next: decoded.nextCursor
          ? sign({
              subscriptionId: session.subscriptionId,
              conversationId: t.conversationId,
              direction,
              after,
              through: page.throughSequence,
              cursor: decoded.nextCursor,
            })
          : null,
      };
    },
    async cardAction(input) {
      const t = await connect();
      if (t.conversationId !== input.conversationId)
        throw new AssistantWebError(409, '助手会话已变更，请刷新');
      const result = await t.client.request('personal-assistant.call', {
        method: input.actionKey === undefined ? 'assistant.card-status' : 'assistant.card-reply',
        input: { sessionId: t.sessionId, cardId: input.cardId, ...(input.actionKey === undefined ? {} : { actionKey: input.actionKey }) },
      });
      return result.value as { selectedKey: string | null };
    },
    async send(input) {
      const t = await connect();
      if (t.conversationId !== input.conversationId)
        throw new AssistantWebError(409, '助手会话已变更，请刷新后重新发送');
      const result = await t.client.submitMessage({
        sessionId: t.sessionId,
        messageId: input.id,
        content: { text: input.text },
        placement: 'current_turn',
      });
      if (result.disposition === 'blocked')
        throw new AssistantWebError(409, '消息未送达，请在桌面端检查助手状态');
    },
    async close() {
      closed = true;
      await opening?.catch(() => {});
      await observed?.session.close();
      observed = undefined;
    },
  };
}
