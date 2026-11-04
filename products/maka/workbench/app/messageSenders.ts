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
import type { MessageOrigin } from '../../../../packages/plugin-sdk/src/index.js';
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
  host: Pick<Host, 'query'>,
  ids: () => Iterable<string>,
  known: (id: string) => SenderSession | undefined,
  openBeside: () => MessageSenders['openBeside'],
): MessageSenders {
  const sources = new Map<string, { session: SenderSession | null }>();
  const revision = signal(0);
  effect(() => {
    const wanted = new Set(ids());
    for (const id of sources.keys()) {
      if (!wanted.has(id) || known(id)) sources.delete(id);
    }
    for (const id of wanted) {
      if (known(id) || sources.has(id)) continue;
      const entry: { session: SenderSession | null } = { session: null };
      sources.set(id, entry);
      void host.query('agent', 'observe', { sessionId: id }).then(
        ({ session }) => {
          if (sources.get(id) !== entry) return;
          entry.session = { title: session.title };
          revision.set(revision() + 1);
        },
        () => {}, // Missing or unavailable sources retain the generic badge.
      );
    }
  });
  cleanup(() => sources.clear());
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
