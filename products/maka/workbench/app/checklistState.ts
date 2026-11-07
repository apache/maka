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

import { batch, cleanup, signal } from 'nsh';
import type { ComposerChecklistSource } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { AgentChecklist, AgentTodoItem } from '../../../../packages/plugin-sdk/src/index.js';
import type { Subscription } from './history';
import { createText, errorText, isObservationCancelled, UiError } from './text';

// The list each conversation's strip was hidden for, so switching away and
// back does not bring it back. A different list is new work and shows again.
const hidden = new Map<string, string>();

/** The item in progress, or else the first one left to do; -1 when neither is among `items`. */
export function checklistPosition(items: readonly AgentTodoItem[]): number {
  const active = items.findIndex((item) => item.status === 'in_progress');
  return active >= 0 ? active : items.findIndex((item) => item.status !== 'completed');
}

export function createChecklistState(source: ComposerChecklistSource, sessionId: string) {
  const snapshot = signal<AgentChecklist | null>(null);
  const items = signal<AgentTodoItem[]>([]);
  const nextOffset = signal<AgentChecklist['nextOffset']>(null);
  const loading = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let stream: Subscription | null = null;
  let reading: Promise<void> = Promise.resolve();
  const read = async () => {
    const page = snapshot();
    const offset = nextOffset();
    if (!alive || loading() || !page || offset === null || offset === undefined) return;
    const currentGeneration = generation;
    loading.set(true);
    error.set('');
    try {
      const next = await source.read(offset);
      // A replacement invalidates every previously loaded page. Never stitch
      // pages from two checklist revisions; the watch supplies the new head.
      if (!alive || currentGeneration !== generation || next.revision !== page.revision) return;
      batch(() => {
        items.set([...items(), ...next.items]);
        nextOffset.set(next.nextOffset);
      });
    } catch (reason) {
      if (alive && currentGeneration === generation) error.set(errorText(reason));
    } finally {
      if (alive && currentGeneration === generation) loading.set(false);
    }
  };
  // Settles once the page being read, if any, has arrived.
  const loadMore = () => {
    if (!loading()) reading = read();
    return reading;
  };
  cleanup(() => {
    alive = false;
    const previous = stream;
    stream = null;
    if (previous) void previous.close().catch(() => {});
  });
  void (async () => {
    for (let reconnects = 0; alive; ) {
      let opened: Subscription | null = null;
      try {
        opened = await source.watch(0);
        if (!alive) {
          await opened.close();
          return;
        }
        stream = opened;
        for (;;) {
          const page: AgentChecklist | null = await opened.next();
          if (!alive) return;
          if (page === null) throw new UiError('Checklist updates ended. Reopen the conversation.');
          reconnects = 0;
          if (snapshot() && page.revision === snapshot()!.revision) continue;
          generation += 1;
          batch(() => {
            snapshot.set(page);
            items.set(page.items);
            nextOffset.set(page.nextOffset);
            loading.set(false);
            error.set('');
          });
        }
      } catch (reason) {
        if (!alive) return;
        if (isObservationCancelled(reason) && reconnects < 3) {
          reconnects += 1;
          if (reconnects > 1) await new Promise((resolve) => setTimeout(resolve, 250 * reconnects));
          continue;
        }
        throw reason;
      } finally {
        if (opened && stream === opened) {
          stream = null;
          await opened.close().catch(() => {});
        }
      }
    }
  })().catch((reason) => {
    if (alive) error.set(errorText(reason));
  });
  // Statuses change as work moves on; the items' text and count identify the list.
  const identity = () =>
    error()
      ? `error:${error()}`
      : JSON.stringify([
          snapshot()?.total ?? 0,
          (snapshot()?.items ?? []).map((item) => item.content),
        ]);
  const hiddenList = signal(hidden.get(sessionId) ?? null);
  const complete = () => !!snapshot()?.total && snapshot()!.completed === snapshot()!.total;
  return {
    snapshot,
    items,
    error,
    loadMore,
    complete,
    shown: () =>
      (!!error() || (!!snapshot()?.enabled && snapshot()!.total > 0)) &&
      hiddenList() !== identity(),
    hide() {
      const list = identity();
      hidden.set(sessionId, list);
      hiddenList.set(list);
    },
    /**
     * Reads on while every loaded item is done but more remain, until the
     * item in progress or the first one left to do arrives, and gives its
     * index (-1 when the reads stop first). Stops early once `wanted` fails.
     */
    async reveal(wanted: () => boolean) {
      // The list has fewer pages than items, which bounds reads that keep
      // being discarded while a replacement is on its way.
      for (let reads = 0; reads < (snapshot()?.total ?? 0); reads += 1) {
        const offset = nextOffset();
        if (
          !alive ||
          !wanted() ||
          checklistPosition(items()) >= 0 ||
          complete() ||
          error() ||
          offset === null ||
          offset === undefined
        )
          break;
        await loadMore();
      }
      return checklistPosition(items());
    },
  };
}
