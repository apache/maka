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

import { isObservationCancelled, UiError } from './text';
import type { Host } from './host';
import type { ResourceUpdate } from '../../../../packages/plugin-sdk/src/index.js';

export type Stream<T> = { next(): Promise<T | null>; close(): Promise<void> };
export type Watch<T> = { closed: boolean; stream: Stream<T> | null };

export function completed<T>(
  outcome: { kind: 'completed'; value: T } | { kind: 'failed'; message: string },
): T {
  if (outcome.kind === 'failed') throw new Error(outcome.message);
  return outcome.value;
}

export const terminalRunning = (entry: ResourceUpdate) =>
  entry.result.status === 'starting' || entry.result.status === 'running';

export const stopWatch = (watch: Watch<unknown> | null) => {
  if (!watch) return;
  watch.closed = true;
  const stream = watch.stream;
  watch.stream = null;
  if (stream) void stream.close().catch(() => {});
};

/**
 * Follows a Session's complete terminal list until `current()` turns false or the Host
 * fails beyond the reconnect budget, which is thrown. Each Host revision is delivered
 * whole, with every later page already read.
 */
export async function followTerminalList(
  host: Pick<Host, 'subscribe' | 'query'>,
  sessionId: string,
  run: Watch<unknown>,
  current: () => boolean,
  accept: (resources: ResourceUpdate[]) => void,
): Promise<void> {
  for (let reconnects = 0; current(); ) {
    try {
      const opened = await host.subscribe('terminal', 'watchList', { sessionId, offset: 0 });
      if (!current()) {
        await opened.close();
        return;
      }
      run.stream = opened;
      try {
        for (;;) {
          const outcome = await opened.next();
          if (!current()) return;
          if (!outcome) throw new UiError('The Host closed the terminal list.');
          reconnects = 0;
          const page = completed(outcome);
          const resources = [...page.resources];
          for (let offset = page.nextOffset ?? null; offset !== null; ) {
            const more = completed(await host.query('terminal', 'list', { sessionId, offset }));
            if (!current()) return;
            resources.push(...more.resources);
            offset = more.nextOffset ?? null;
          }
          accept(resources);
        }
      } finally {
        if (run.stream === opened) {
          run.stream = null;
          await opened.close().catch(() => {});
        }
      }
    } catch (reason) {
      if (!current()) return;
      if (isObservationCancelled(reason) && reconnects < 3) {
        reconnects += 1;
        if (reconnects > 1) await new Promise((resolve) => setTimeout(resolve, 250 * reconnects));
        continue;
      }
      throw reason;
    }
  }
}
