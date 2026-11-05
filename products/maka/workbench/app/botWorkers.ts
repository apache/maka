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
import type { AgentSession, AgentSessionPage } from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { assembleChildren } from './botTranscriptCore';
import { isObservationCancelled } from './text';

/**
 * The conversations a Bot created, kept current by the Host's catalog stream. The stream
 * pushes when a worker is created, starts or ends a Turn, waits for the user, is renamed
 * or archived, so nothing is polled. Reads only while `enabled`.
 */
export function createBotWorkers(
  host: Pick<Host, 'query' | 'subscribe'>,
  bot: () => string | null,
  enabled: () => boolean,
) {
  const children = signal<readonly AgentSession[]>([]);
  effect(() => {
    const id = bot();
    if (!id || !enabled()) return;
    const scope = { kind: 'children', sessionId: id } as const;
    let stopped = false;
    let stream: { next(): Promise<AgentSessionPage | null>; close(): Promise<void> } | null = null;
    void (async () => {
      for (let reconnects = 0; !stopped; ) {
        try {
          const opened = await host.subscribe('agent', 'catalog', {
            filter: 'all',
            includeArchived: false,
            scope,
            position: { kind: 'start' },
          });
          if (stopped) {
            await opened.close();
            return;
          }
          stream = opened;
          let lastRevision: string | null = null;
          try {
            while (!stopped) {
              const page = await opened.next();
              if (stopped || page === null) return;
              reconnects = 0;
              if (page.revision === lastRevision) continue;
              try {
                const rows = await assembleChildren<AgentSession, AgentSessionPage>(
                  page,
                  (previous) =>
                    host.query('agent', 'list', {
                      filter: 'all',
                      includeArchived: false,
                      scope,
                      position: {
                        kind: 'after',
                        revision: previous.revision,
                        cursor: previous.after!,
                      },
                    }),
                );
                if (!stopped) {
                  lastRevision = page.revision;
                  children.set(rows);
                }
              } catch {
                // The catalog moved or a read failed: keep the last list. A moved catalog pushes
                // its next window, and any later change pushes again.
              }
            }
          } finally {
            if (stream === opened) {
              stream = null;
              await opened.close().catch(() => {});
            }
          }
        } catch (reason) {
          if (stopped) return;
          if (isObservationCancelled(reason) && reconnects < 3) {
            reconnects += 1;
            if (reconnects > 1)
              await new Promise((resolve) => setTimeout(resolve, 250 * reconnects));
            continue;
          }
          throw reason;
        }
      }
    })().catch(() => {
      // The stream ended; the last list stays until this is read again.
    });
    cleanup(() => {
      stopped = true;
      const open = stream;
      stream = null;
      if (open) void open.close().catch(() => {});
    });
  });
  return { sessions: () => children() };
}
