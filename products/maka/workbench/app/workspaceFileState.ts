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

import { createText, errorText, UiError } from './text';
import { tr } from './locale';
import { batch, cleanup, effect, signal, untracked } from 'nsh';
import { host } from './host';
import type {
  AgentFileChange,
  AgentFileCursor,
  AgentFileEntry,
  AgentFilePage,
  WorkspacePath,
} from '../../../../packages/plugin-sdk/src/index.js';

export type WorkspaceFileTarget = {
  sessionId: string;
  path: WorkspacePath;
  parent: WorkspacePath | null;
  title: string;
};
export type WorkspaceDirectoryTarget = { sessionId: string; path: WorkspacePath | null };
export type WorkspaceFileAction = {
  sessionId: string;
  parent: WorkspacePath | null;
  entry: AgentFileEntry;
};
export type WorkspaceDirectory = { path: WorkspacePath | null; title: string };
export type WorkspaceFilesModel = {
  sessionId(): string | null;
  active(): boolean;
  breadcrumbs(): WorkspaceDirectory[];
  entries(): AgentFileEntry[];
  loading(): boolean;
  busy(): boolean;
  error(): string;
  position: { x: number; y: number };
  navigate(target: WorkspaceDirectoryTarget): void;
  activate(target: WorkspaceFileAction): void;
  refresh(): void;
  loadMore(): Promise<void>;
};

type Subscription = {
  next(): Promise<AgentFileChange | null>;
  close(): Promise<void>;
};
type DirectoryRead = {
  sessionId: string;
  path: WorkspacePath | null;
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

// The owner survives presentation changes; each active directory owns one watch
// and one list request. Directory identity is not a content revision.
export function createWorkspaceFiles(options: {
  sessionId(): string | null;
  active(): boolean;
  openFile(target: WorkspaceFileTarget): void;
}): WorkspaceFilesModel {
  const breadcrumbs = signal<WorkspaceDirectory[]>([
    {
      path: null,
      get title() {
        return tr('Workspace');
      },
    },
  ]);
  const entries = signal<AgentFileEntry[]>([]);
  const loading = signal(false);
  const busy = signal(false);
  const error = createText();
  const position = { x: 0, y: 0 };
  let alive = true;
  let sessionId: string | null = null;
  let current: DirectoryRead | null = null;
  const active = () => alive && options.active() && options.sessionId() !== null;
  const owns = (read: DirectoryRead) =>
    active() && current === read && options.sessionId() === read.sessionId;
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
      error.set(errorText(reason));
      loading.set(false);
      busy.set(false);
    });
  };
  const pump = async (read: DirectoryRead) => {
    if (!owns(read) || read.reading || read.identity === null) return;
    read.reading = true;
    busy.set(true);
    try {
      refill: while (owns(read) && (read.dirty || read.extend)) {
        const generation = read.generation;
        const valid = () => owns(read) && read.generation === generation;
        const list = async (after: AgentFileCursor | null) => {
          const page: AgentFilePage = await host.query('agent', 'listFiles', {
            sessionId: read.sessionId,
            path: read.path,
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
            error.set('');
            loading.set(false);
          });
        } catch (reason) {
          if (valid()) fail(read, reason);
        }
      }
    } finally {
      read.reading = false;
      if (owns(read)) {
        batch(() => {
          busy.set(false);
          loading.set(false);
        });
      }
    }
  };
  const invalidate = (read: DirectoryRead) => {
    if (!owns(read)) return;
    read.generation += 1;
    read.dirty = true;
    batch(() => {
      error.set('');
      busy.set(true);
    });
    void pump(read);
  };
  const start = (clear = false) => {
    stop();
    batch(() => {
      if (clear) {
        position.x = 0;
        position.y = 0;
        entries.set([]);
      }
      error.set('');
      loading.set(clear && active());
      busy.set(active());
    });
    const original = options.sessionId();
    if (!active() || original === null) return;
    const read: DirectoryRead = {
      sessionId: original,
      path: breadcrumbs().at(-1)!.path,
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
      const opened: Subscription = await host.subscribe('agent', 'watchFiles', {
        sessionId: read.sessionId,
        path: read.path,
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
        if (change.kind === 'unavailable')
          throw new UiError('The directory changed or is unavailable. Refresh to reopen it.');
        if (change.kind === 'ready') read.identity = change.directoryIdentity;
        invalidate(read);
      }
    })().catch((reason) => fail(read, reason));
  };
  effect(() => {
    const selected = options.sessionId();
    options.active();
    untracked(() => {
      const changed = selected !== sessionId;
      if (changed) {
        sessionId = selected;
        position.x = 0;
        position.y = 0;
        breadcrumbs.set([
          {
            path: null,
            get title() {
              return tr('Workspace');
            },
          },
        ]);
      }
      start(changed);
    });
  });
  cleanup(() => {
    alive = false;
    stop();
  });
  const navigate = (target: WorkspaceDirectoryTarget) => {
    if (!active() || target.sessionId !== options.sessionId()) return;
    const index = breadcrumbs().findIndex((directory) => samePath(directory.path, target.path));
    if (index < 0 || index === breadcrumbs().length - 1) return;
    position.x = 0;
    position.y = 0;
    breadcrumbs.set(breadcrumbs().slice(0, index + 1));
    start(true);
  };
  const activate = (target: WorkspaceFileAction) => {
    const read = current;
    if (
      !read ||
      !owns(read) ||
      error() ||
      target.sessionId !== read.sessionId ||
      !samePath(target.parent, read.path)
    )
      return;
    const entry = entries().find((entry) => samePath(entry.path, target.entry.path));
    if (!entry || entry.kind !== target.entry.kind) return;
    const title: string = host.pathLabel(entry.path);
    if (entry.kind === 'directory') {
      position.x = 0;
      position.y = 0;
      breadcrumbs.set([...breadcrumbs(), { path: entry.path, title }]);
      start(true);
    } else if (entry.kind === 'file') {
      options.openFile({
        sessionId: read.sessionId,
        path: entry.path,
        parent: read.path,
        title,
      });
    }
  };
  return {
    sessionId: options.sessionId,
    active,
    breadcrumbs,
    entries,
    loading,
    busy,
    error,
    position,
    navigate,
    activate,
    refresh: () => {
      if (active()) start();
    },
    loadMore: async () => {
      const read = current;
      if (!read || !owns(read) || error() || (!read.dirty && read.page && !read.page.next)) return;
      read.extend = true;
      loading.set(true);
      await pump(read);
    },
  };
}
