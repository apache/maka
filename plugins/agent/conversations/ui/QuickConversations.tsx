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

import { cleanup, effect, signal } from 'nsh';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import type {
  QuickItem,
  QuickToolInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import type { Host, Output } from '../../../../products/maka/workbench/app/host';
import { tr } from '../../../../products/maka/workbench/app/locale';

export interface ConversationLauncher {
  visible(): boolean;
  sessionQuery(): string | null;
  openBot(): void;
  askQuestion(text: string): void;
  openHistory(): void;
  openSession(id: string | null): void;
}
export interface QuickConversationsInput extends QuickToolInput {
  conversations: ConversationLauncher;
}
const clock = (at: number) => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** The Bot's newest unread message, for as long as the launcher shows. */
function watchUnread(host: Host, fail: (reason: unknown) => void) {
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
export function QuickConversations(props: { input: QuickConversationsInput; host: Host }) {
  const { input, host } = props;
  const navigation = input.conversations;
  const sessions = signal<AgentSession[]>([]);
  const unread = signal<{ preview: string; at: number } | null>(null);
  effect(() => {
    if (!navigation.visible()) return;
    const current = watchUnread(host, input.report);
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
        trailing: unread() ? clock(unread()!.at) : undefined,
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
        run: navigation.openHistory,
      },
    ],
    items(): QuickItem[] {
      const text = navigation.sessionQuery();
      if (text === null) return [];
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
