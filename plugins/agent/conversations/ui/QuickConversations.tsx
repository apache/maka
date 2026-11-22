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

import { cleanup, computed, effect, signal, untracked } from 'nsh';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import type {
  QuickItem,
  QuickToolInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { createBrowsing } from '../../../../products/maka/workbench/app/browsing';
import { isReplyWithActions } from '../../../../products/maka/workbench/app/history';
import type { Host, Output } from '../../../../products/maka/workbench/app/host';
import { messageTime, tr } from '../../../../products/maka/workbench/app/locale';

export interface ConversationLauncher {
  visible(): boolean;
  home(): boolean;
  sessionQuery(): string | null;
  openBot(): void;
  askQuestion(text: string): void;
  historyItems(): QuickItem[];
  historyStatus(): string;
  openSession(id: string | null): void;
}
export interface QuickConversationsInput extends QuickToolInput {
  conversations: ConversationLauncher;
}
/** The Bot's newest unread message, for as long as the launcher shows. */
function watchUnread(
  host: Host,
  fail: (reason: unknown) => void,
  botId: (id: string | null) => void,
) {
  const unread = signal<{ preview: string; at: number } | null>(null);
  let alive = true;
  let stream:
    | { next(): Promise<Output<'agent', 'watchBotOutbox'> | null>; close(): Promise<void> }
    | undefined;
  cleanup(() => {
    alive = false;
    void stream?.close().catch(fail);
  });
  void (async () => {
    stream = await host.subscribe('agent', 'watchBotOutbox', { limit: 0 });
    if (!alive) return void (await stream.close());
    for (;;) {
      const head = await stream.next();
      if (!alive || head === null) return;
      botId(head.sessionId ?? null);
      if (!head.isBot || head.through <= head.readThrough) {
        unread.set(null);
        continue;
      }
      const page = await host.query('agent', 'botOutbox', {
        after: head.through - 1,
        limit: 1,
      });
      if (!alive) return;
      unread.set({ preview: head.preview, at: page.messages[0]!.at });
    }
  })().catch((reason) => {
    if (alive) fail(reason);
  });
  return unread;
}
type ReplyPreview = { at: number; text: string };
async function readReply(
  host: Host,
  session: AgentSession,
  messageId: string,
): Promise<ReplyPreview | null> {
  const page = await host.query('agent', 'history', {
    sessionId: session.id,
    position: { kind: 'tail' },
    view: 'chat',
    includeThinking: false,
  });
  if (page.kind !== 'ready') return null;
  const matches = (chunk: (typeof page.chunks)[number]) =>
    chunk.messageId === messageId && isReplyWithActions(chunk);
  let parts = page.chunks.filter(matches);
  const first = parts[0];
  if (first && first.offset > 0) {
    // A long reply can fill the whole tail page. Resolve its beginning at the same fence.
    const start = await host.query('agent', 'history', {
      sessionId: session.id,
      through: page.through,
      view: 'chat',
      includeThinking: false,
      position: { kind: 'row', position: first.position, field: 'body' },
    });
    if (start.kind !== 'ready') return null;
    parts = start.chunks.filter(matches);
  }
  const text = parts
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return {
    text: Array.from(text).slice(0, 160).join(''),
    at: parts[0]!.timestamp ?? session.updatedAt,
  };
}

// Share the Host's unread cursor with the main app. Rendering a suggestion is a read-only
// observation; the conversation itself acknowledges a reply only after it is visible.
function unreadSessionItems(
  host: Host,
  botId: () => string | null | undefined,
  navigation: ConversationLauncher,
) {
  const catalog = createBrowsing(host);
  effect(() => {
    if (catalog.hasMore() && !catalog.loading() && !catalog.error())
      untracked(() => void catalog.loadMore());
  });
  const sessions = computed(() =>
    catalog
      .sessions()
      .filter(
        (s) =>
          botId() !== undefined &&
          s.id !== botId() &&
          !s.parentSessionId &&
          !s.archived &&
          s.hasUnread &&
          s.activity === 'idle' &&
          !!s.tailMessageId,
      ),
  );
  type Entry = { tail: string; result: Promise<ReplyPreview | null> };
  const cache = new Map<string, Entry>();
  const previews = signal<ReadonlyMap<string, { tail: string; reply: ReplyPreview | null }>>(
    new Map(),
  );
  effect(() => {
    const current = sessions();
    navigation.visible(); // Retry failed previews on the next open.
    let active = true;
    cleanup(() => {
      active = false;
    });
    const ids = new Set(current.map((session) => session.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const reads = current.map(async (session) => {
      const tail = session.tailMessageId!;
      let entry = cache.get(session.id);
      if (!entry || entry.tail !== tail) {
        entry = { tail, result: readReply(host, session, tail) };
        cache.set(session.id, entry);
      }
      try {
        return [session.id, { tail, reply: await entry.result }] as const;
      } catch {
        if (cache.get(session.id) === entry) cache.delete(session.id);
        return [session.id, { tail, reply: null }] as const;
      }
    });
    void Promise.all(reads).then((results) => {
      if (active) previews.set(new Map(results));
    });
  });
  return (): QuickItem[] =>
    sessions().flatMap((s) => {
      const found = previews().get(s.id);
      const reply = found?.tail === s.tailMessageId ? found?.reply : null;
      return reply
        ? [
            {
              id: s.id,
              title: s.title,
              detail: reply.text,
              icon: 'note',
              source: tr('Session chat'),
              action: tr('Open'),
              match: 0,
              recommendedAt: reply.at,
              run: () => navigation.openSession(s.id),
            },
          ]
        : [];
    });
}

export function QuickConversations(props: { input: QuickConversationsInput; host: Host }) {
  const { input, host } = props;
  const navigation = input.conversations;
  const sessions = signal<AgentSession[]>([]);
  const botId = signal<string | null | undefined>(undefined);
  const unreadItems = unreadSessionItems(host, botId, navigation);
  const unread = signal<{ preview: string; at: number } | null>(null);
  effect(() => {
    if (!navigation.visible()) return;
    const current = watchUnread(host, input.report, (id) => botId.set(id));
    effect(() => unread.set(current()));
  });
  effect(() => {
    const text = navigation.sessionQuery();
    sessions.set([]);
    if (text === null) return;
    let alive = true;
    cleanup(() => {
      alive = false;
    });
    void Promise.all([
      host.query('agent', 'list', {
        kind: 'agent',
        filter: 'all',
        rootsOnly: true,
        titleQuery: text,
        position: { kind: 'start' },
      }),
      host.query('agent', 'botOutbox', { limit: 0 }),
    ])
      .then(([page, bot]) => {
        if (alive) sessions.set(page.sessions.filter((s) => s.id !== bot.sessionId));
      })
      .catch((reason) => {
        if (alive) input.report(reason);
      });
  });
  input.attach({
    askQuestion: navigation.askQuestion,
    entries: () => [
      {
        id: 'bot',
        title: 'Maka Bot',
        icon: 'maka',
        keywords: ['bot', 'Maka Bot', '助手'],
        detail: unread()?.preview,
        unread: unread() !== null,
        trailing: unread() ? messageTime(unread()!.at) : undefined,
        run: navigation.openBot,
      },
      {
        id: 'sessions',
        title: tr('Session chat'),
        icon: 'maka',
        keywords: ['session', '会话', '會話', 'chat'],
      },
      {
        id: 'history',
        title: tr('Quick Q&A'),
        icon: 'maka',
        keywords: [
          'qa',
          'history',
          '快问',
          '快問',
          '快问历史',
          '快問歷史',
          'library',
          'quick question history',
        ],
      },
    ],
    emptyMessage: navigation.historyStatus,
    items(): QuickItem[] {
      const text = navigation.sessionQuery();
      if (text === null) return navigation.home() ? unreadItems() : navigation.historyItems();
      const items: QuickItem[] = sessions().map((s) => ({
        id: s.id,
        title: s.title,
        icon: 'note',
        source: tr('Session chat'),
        action: tr('Open'),
        match: 0,
        run: () => navigation.openSession(s.id),
      }));
      if (!text.trim())
        items.unshift({
          id: 'new-session',
          title: tr('Start a new conversation'),
          icon: 'note',
          source: tr('Session chat'),
          action: tr('Open'),
          match: 0,
          run: () => navigation.openSession(null),
        });
      return items;
    },
  });
  return null;
}
