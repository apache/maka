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
import { createText, errorText, isObservationCancelled, UiError, type UiText } from './text';

// Each entry is a session UUID and a 64-byte SHA-256 hex digest (~100 B),
// cleared as soon as that session's checklist changes or clears, and bounded so
// deleted conversations cannot accumulate unbounded process-wide state.
const MAX_HIDDEN_SESSIONS = 512;
const hidden = new Map<string, string>();

function rememberHidden(sessionId: string, digest: string) {
  hidden.delete(sessionId);
  if (hidden.size >= MAX_HIDDEN_SESSIONS) {
    const oldest = hidden.keys().next().value;
    if (oldest !== undefined) hidden.delete(oldest);
  }
  hidden.set(sessionId, digest);
}

function isStaleRevision(
  next: AgentChecklist['revision'],
  current: AgentChecklist['revision'],
): boolean {
  if (current === null || current === undefined) return false;
  if (next === null || next === undefined) return true;
  return next < current;
}

export function createChecklistState(source: ComposerChecklistSource, sessionId: string) {
  const snapshot = signal<AgentChecklist | null>(null);
  const items = signal<AgentTodoItem[]>([]);
  const nextOffset = signal<AgentChecklist['nextOffset']>(null);
  const loading = signal(false);
  const error = createText();
  const dismissed = signal<string | null>(hidden.get(sessionId) ?? null);
  let alive = true;
  let generation = 0;
  let openPanels = 0;
  let stream: Subscription | null = null;
  let reading: Promise<void> = Promise.resolve();

  const shouldAcceptHead = (incoming: AgentChecklist): boolean => {
    const current = snapshot();
    if (!current) return true;
    if (isStaleRevision(incoming.revision, current.revision)) return false;
    if (
      (incoming.revision ?? null) === (current.revision ?? null) &&
      incoming.enabled === current.enabled &&
      (incoming.digest ?? null) === (current.digest ?? null)
    ) {
      return incoming.offset === 0 && incoming.items.length > items().length;
    }
    return true;
  };

  const commitHead = (head: AgentChecklist, headError: UiText = '') => {
    if (!alive || !shouldAcceptHead(head)) return false;
    const currentDismissed = dismissed();
    const clearDismissed = currentDismissed !== null && (head.digest ?? null) !== currentDismissed;
    if (clearDismissed) hidden.delete(sessionId);
    generation += 1;
    batch(() => {
      if (clearDismissed) dismissed.set(null);
      snapshot.set(head);
      items.set(head.items);
      nextOffset.set(head.nextOffset);
      loading.set(false);
      error.set(headError);
    });
    return true;
  };

  const desiredOpenWindow = (head: AgentChecklist): number => {
    if (openPanels <= 0) return head.items.length;
    const activeWindow =
      head.activeIndex !== null && head.activeIndex !== undefined ? head.activeIndex + 20 : 20;
    return Math.min(head.total, Math.max(items().length, activeWindow));
  };

  const readWindow = async (targetCount?: number) => {
    const page = snapshot();
    const offset = nextOffset();
    if (!alive || loading() || !page || offset === null || offset === undefined) return;
    const needed =
      targetCount === undefined ? 20 : Math.max(20, Math.min(page.total, targetCount) - offset);
    if (needed <= 0) return;
    const currentGeneration = generation;
    loading.set(true);
    error.set('');
    try {
      const next = await source.read(offset, needed);
      if (!alive || currentGeneration !== generation) return;
      if (next.revision !== page.revision) {
        // Storage moved ahead of the watch stream; adopt the new head directly
        // in one read instead of spinning against the superseded revision.
        if (!isStaleRevision(next.revision, page.revision)) {
          const activeTarget =
            next.activeIndex !== null && next.activeIndex !== undefined
              ? next.activeIndex + 20
              : 20;
          const refreshLimit = Math.min(
            next.total,
            Math.max(targetCount ?? 20, items().length, activeTarget),
          );
          const fresh =
            next.offset === 0 && next.items.length >= refreshLimit
              ? next
              : await source.read(0, Math.max(20, refreshLimit));
          if (!alive || currentGeneration !== generation) return;
          commitHead(fresh);
        }
        return;
      }
      if (next.offset !== offset) return;
      batch(() => {
        items.set([...items(), ...next.items]);
        nextOffset.set(next.nextOffset);
      });
    } catch (reason) {
      if (alive && currentGeneration === generation)
        error.set(errorText(reason, 'Could not load the checklist.'));
    } finally {
      if (alive && currentGeneration === generation) loading.set(false);
    }
  };

  const loadMore = () => {
    if (!loading()) reading = readWindow();
    return reading;
  };

  const loadThrough = (targetCount: number) => {
    if (!loading()) reading = readWindow(targetCount);
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
          if (!shouldAcceptHead(page)) continue;
          const windowSize = desiredOpenWindow(page);
          if (windowSize > page.items.length) {
            try {
              const expanded = await source.read(0, windowSize);
              if (!alive) return;
              commitHead(expanded);
            } catch (reason) {
              if (!alive) return;
              commitHead(page, errorText(reason, 'Could not load the checklist.'));
            }
          } else {
            commitHead(page);
          }
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
    if (alive) error.set(errorText(reason, 'Could not load the checklist.'));
  });

  const isDismissed = () => {
    const digest = snapshot()?.digest ?? null;
    return digest !== null && dismissed() === digest;
  };
  const complete = () => !!snapshot()?.total && snapshot()!.completed === snapshot()!.total;

  return {
    snapshot,
    items,
    error,
    loadMore,
    complete,
    open() {
      openPanels += 1;
      let closed = false;
      return () => {
        if (!closed) {
          closed = true;
          openPanels -= 1;
        }
      };
    },
    shown: () =>
      !isDismissed() && (!!error() || (!!snapshot()?.enabled && (snapshot()?.total ?? 0) > 0)),
    hide() {
      const digest = snapshot()?.digest ?? null;
      if (digest !== null) {
        rememberHidden(sessionId, digest);
        dismissed.set(digest);
      } else if (error()) {
        error.set('');
      }
    },
    /**
     * Ensures the checklist's active item is loaded and returns its index
     * (-1 when no active item exists, `wanted` turns false, or a read fails).
     */
    async reveal(wanted: () => boolean): Promise<number> {
      if (!alive || !wanted() || error()) return -1;
      if (loading()) await reading;
      const page = snapshot();
      if (!alive || !wanted() || error() || !page) return -1;
      const target = page.activeIndex ?? -1;
      if (target < 0) return -1;
      if (target >= items().length && nextOffset() !== null && nextOffset() !== undefined) {
        await loadThrough(target + 20);
      }
      if (!alive || !wanted() || error()) return -1;
      const resolved = snapshot()?.activeIndex ?? -1;
      return resolved >= 0 && resolved < items().length ? resolved : -1;
    },
  };
}
