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
import type {
  AgentSession,
  AgentSessionListScope,
  AgentSessionPage,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { assembleChildren } from './botTranscriptCore';
import { isObservationCancelled } from './text';

/**
 * The conversations of one catalog scope, kept current by the Host's catalog stream: the
 * stream pushes each change, so nothing is polled. Reads only while `scoped` gives a scope.
 */
export function createScopedCatalog(
  host: Pick<Host, 'query' | 'subscribe'>,
  scoped: () => AgentSessionListScope | null,
) {
  const children = signal<readonly AgentSession[]>([]);
  let shown = '';
  effect(() => {
    const scope = scoped();
    if (!scope) return;
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
                  // The catalog revision moves with any conversation: keep the list when it did not.
                  const key = JSON.stringify(rows);
                  if (key !== shown) {
                    shown = key;
                    children.set(rows);
                  }
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
  return () => children();
}
