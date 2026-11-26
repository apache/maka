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
import type { AgentWorkerProgress } from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { createScopedCatalog } from './scopedCatalog';

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
  const sessions = createScopedCatalog(host, () => {
    const id = bot();
    return id && enabled() ? { kind: 'children', sessionId: id } : null;
  });
  const progress = signal<ReadonlyMap<string, AgentWorkerProgress>>(new Map());
  effect(() => {
    const parentSessionId = bot();
    progress.set(new Map());
    if (!enabled() || !parentSessionId) return;
    let stopped = false;
    let stream: { close(): Promise<void> } | undefined;
    cleanup(() => {
      stopped = true;
      void stream?.close().catch(() => {});
    });
    void (async () => {
      while (!stopped) {
        try {
          const opened = await host.subscribe('agent', 'watchWorkerProgress', { parentSessionId });
          stream = opened;
          try {
            while (!stopped) {
              const frame = await opened.next();
              if (stopped || !frame) break;
              const rows = frame.snapshot
                ? new Map<string, AgentWorkerProgress>()
                : new Map(progress());
              let changed = frame.snapshot;
              for (const id of frame.remove) {
                if (rows.delete(id)) changed = true;
              }
              for (const row of frame.upsert) {
                const prev = rows.get(row.sessionId);
                // A parent stream sequences replacements as well as updates within a run.
                if (!prev || prev.seq < row.seq) {
                  rows.set(row.sessionId, row);
                  changed = true;
                }
              }
              if (changed) progress.set(rows);
            }
          } finally {
            stream = undefined;
            await opened.close();
          }
        } catch {
          /* The scoped catalog remains available while reconnecting. */
        }
        if (!stopped) {
          progress.set(new Map());
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();
  });
  return { sessions, progress };
}
