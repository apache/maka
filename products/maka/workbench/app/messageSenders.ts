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
import type { AgentSessionPage, MessageOrigin } from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';

type SenderSession = { title: string };
export type MessageSenders = {
  session(id: string): SenderSession | null;
  openBeside?(id: string): void;
};

export function senderSession(origin: MessageOrigin | null | undefined): string | null {
  return origin?.kind === 'session' ? origin.invocation.session_id : null;
}

/** One mounted history window owns only its currently referenced, unknown sources. */
export function createMessageSenders(
  host: Pick<Host, 'subscribe'>,
  ids: () => Iterable<string>,
  known: (id: string) => SenderSession | undefined,
  openBeside: () => MessageSenders['openBeside'],
): MessageSenders {
  type Source = {
    session: SenderSession | null;
    stream: { next(): Promise<AgentSessionPage | null>; close(): Promise<void> } | null;
  };
  const sources = new Map<string, Source>();
  const revision = signal(0);
  const close = (entry: Source) => {
    const stream = entry.stream;
    entry.stream = null;
    if (stream) void stream.close().catch(() => {});
  };
  effect(() => {
    const wanted = new Set(ids());
    for (const [id, entry] of sources) {
      if (!wanted.has(id) || known(id)) {
        sources.delete(id);
        close(entry);
      }
    }
    for (const id of wanted) {
      if (known(id) || sources.has(id)) continue;
      const entry: Source = { session: null, stream: null };
      sources.set(id, entry);
      void (async () => {
        // Catalog metadata follows renames without observing the source's stream.
        const stream = await host.subscribe('agent', 'catalog', {
          filter: 'all',
          includeArchived: true,
          position: { kind: 'at', cursor: id },
        });
        if (sources.get(id) !== entry) {
          await stream.close();
          return;
        }
        entry.stream = stream;
        for (;;) {
          const page = await stream.next();
          if (sources.get(id) !== entry) return;
          if (page === null) throw new Error('Sender metadata updates ended.');
          const session = page.sessions.find((session) => session.id === id);
          const next = session ? { title: session.title } : null;
          if (entry.session?.title === next?.title) continue;
          entry.session = next;
          revision.set(revision() + 1);
        }
      })()
        .catch(() => {
          // Missing or unavailable sources retain the generic badge.
          if (sources.get(id) === entry && entry.session !== null) {
            entry.session = null;
            revision.set(revision() + 1);
          }
        })
        .finally(() => close(entry));
    }
  });
  cleanup(() => {
    for (const entry of sources.values()) close(entry);
    sources.clear();
  });
  return {
    session(id) {
      revision();
      return known(id) ?? sources.get(id)?.session ?? null;
    },
    get openBeside() {
      return openBeside();
    },
  };
}
