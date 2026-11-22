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

import { batch, signal } from 'nsh';
import { createText, errorText, isObservationCancelled, UiError } from './text';
import type { Host } from './host';
import type {
  AgentFileChange,
  AgentFileCursor,
  AgentFileEntry,
  AgentFilePage,
  WorkspacePath,
} from '../../../../packages/plugin-sdk/src/index.js';

type Subscription = {
  next(): Promise<AgentFileChange | null>;
  close(): Promise<void>;
};
type DirectoryRead = {
  stream: Subscription | null;
  identity: string | null;
  generation: number;
  reading: boolean;
  dirty: boolean;
  extend: boolean;
  page: AgentFilePage | null;
};

const samePath = (left: WorkspacePath | null, right: WorkspacePath | null) =>
  left?.bytesBase64 === right?.bytesBase64;

export function watchDirectory(host: Host, sessionId: string, path: WorkspacePath | null) {
  const entries = signal<AgentFileEntry[]>([]);
  const loading = signal(false);

  const error = createText();
  const next = signal<AgentFileCursor | null>(null);

  let current: DirectoryRead | null = null;

  const owns = (read: DirectoryRead) => current === read;
  const close = (read: DirectoryRead | null) => {
    if (!read) return;
    const stream = read.stream;
    read.stream = null;
    if (stream) void stream.close().catch(() => {});
  };
  const stop = () => {
    const previous = current;
    current = null;
    close(previous);
  };
  const fail = (read: DirectoryRead, reason: unknown) => {
    if (!owns(read)) return;
    stop();
    batch(() => {
      entries.set([]);
      next.set(null);
      error.set(
        errorText(reason, 'The directory changed or is unavailable. Refresh to reopen it.'),
      );
      loading.set(false);
    });
  };
  const pump = async (read: DirectoryRead) => {
    if (!owns(read) || read.reading || read.identity === null) return;
    read.reading = true;

    try {
      refill: while (owns(read) && (read.dirty || read.extend)) {
        const generation = read.generation;
        const valid = () => owns(read) && read.generation === generation;
        const list = async (after: AgentFileCursor | null) => {
          const page: AgentFilePage = await host.query('agent', 'listFiles', {
            sessionId,
            path,
            after,
          });
          if (!valid()) return null;
          if (page.directoryIdentity !== read.identity)
            throw new UiError('The directory changed. Refresh to reopen it.');
          if (page.next && page.next.directoryIdentity !== read.identity)
            throw new UiError('The file cursor belongs to a different directory.');
          if (page.next && samePath(page.next.after, after?.after ?? null))
            throw new UiError('File paging did not advance. Refresh to continue.');
          return page;
        };
        try {
          // This count preserves requested reading depth, not a file snapshot.
          // Only Host cursors determine order; opaque paths are equality keys.
          const extent = entries().length;
          const rows = new Map(
            (read.dirty ? [] : entries()).map((entry) => [entry.path.bytesBase64, entry]),
          );
          let tail = read.page;
          if (read.dirty) {
            let after: AgentFileCursor | null = null;
            do {
              const page = await list(after);
              if (!page) continue refill;
              for (const entry of page.entries) rows.set(entry.path.bytesBase64, entry);
              tail = page;
              after = page.next;
            } while (after && rows.size < extent);
          }
          // Coalesced end demand survives invalidation and an in-flight refill.
          // It admits at most one extra page after the requested prefix.
          if (read.extend && tail?.next) {
            const page = await list(tail.next);
            if (!page) continue refill;
            for (const entry of page.entries) rows.set(entry.path.bytesBase64, entry);
            tail = page;
          }
          if (!valid()) continue;
          read.page = tail;
          read.dirty = false;
          read.extend = false;
          batch(() => {
            entries.set([...rows.values()]);
            next.set(tail?.next ?? null);
            error.set('');
            loading.set(false);
          });
        } catch (reason) {
          if (valid()) fail(read, reason);
        }
      }
    } finally {
      read.reading = false;
      if (owns(read)) loading.set(false);
    }
  };
  const invalidate = (read: DirectoryRead) => {
    if (!owns(read)) return;
    read.generation += 1;
    read.dirty = true;
    error.set('');
    void pump(read);
  };
  const start = () => {
    stop();
    error.set('');
    loading.set(true);
    const read: DirectoryRead = {
      stream: null,
      identity: null,
      generation: 0,
      reading: false,
      dirty: false,
      extend: false,
      page: null,
    };
    current = read;
    void (async () => {
      for (let reconnects = 0; owns(read); ) {
        let opened: Subscription | null = null;
        try {
          opened = await host.subscribe('agent', 'watchFiles', {
            sessionId,
            path,
          });
          if (!owns(read)) {
            await opened.close();
            return;
          }
          read.stream = opened;
          for (;;) {
            const change = await opened.next();
            if (!owns(read)) return;
            if (change === null) throw new UiError('File updates ended. Refresh to reconnect.');
            reconnects = 0;
            if (change.kind === 'unavailable')
              throw new UiError('The directory changed or is unavailable. Refresh to reopen it.');
            if (change.kind === 'ready') read.identity = change.directoryIdentity;
            invalidate(read);
          }
        } catch (reason) {
          if (!owns(read)) return;
          if (isObservationCancelled(reason) && reconnects < 3) {
            reconnects += 1;
            if (reconnects > 1)
              await new Promise((resolve) => setTimeout(resolve, 250 * reconnects));
            continue;
          }
          throw reason;
        } finally {
          if (opened && read.stream === opened) {
            read.stream = null;
            await opened.close().catch(() => {});
          }
        }
      }
    })().catch((reason) => fail(read, reason));
  };
  start();
  return {
    entries,
    loading,
    next,
    error,
    refresh: start,
    close: stop,
    more() {
      const read = current;
      if (read?.page?.next && !read.extend) {
        read.extend = true;
        void pump(read);
      }
    },
  };
}
