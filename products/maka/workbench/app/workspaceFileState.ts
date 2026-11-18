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

import { batch, cleanup, computed, effect, signal, untracked } from 'nsh';
import type { Host } from './host';
import type { AgentFileEntry, WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import { basenameLabel, parentPathOf } from './reviewState';
import type { TreeItem } from 'nsh/base';
import { pathTree } from './fileTreePaths';
import { watchDirectory } from './workspaceDirectory';
import { createText, errorText } from './text';
import { tr } from './locale';

export type WorkspaceFileAnchor = {
  line: number;
  endLine?: number;
  column?: number;
  nonce?: number;
};

export type WorkspaceFileTarget = {
  sessionId: string;
  path: WorkspacePath;
  parent: WorkspacePath | null;
  title: string;
  anchor?: WorkspaceFileAnchor;
};

export type WorkspaceFilesModel = ReturnType<typeof createWorkspaceFiles>;
export function createWorkspaceFiles(
  host: Host,
  options: {
    sessionId(): string | null;
    active(): boolean;
    openFile(target: WorkspaceFileTarget): void;
  },
) {
  const query = signal('');
  const expanded = signal<string[]>([]);
  const closedResults = signal(new Set<string>());
  const matches = signal<AgentFileEntry[]>([]);
  const searching = signal(false);
  const searchError = createText();
  const reads = signal(new Map<string, ReturnType<typeof watchDirectory>>());
  let session: string | null = null;
  function closeAll() {
    for (const read of reads().values()) read.close();
    reads.set(new Map());
  }
  effect(() => {
    const sid = options.sessionId();
    if (sid === session) return;
    session = sid;
    untracked(() =>
      batch(() => {
        closeAll();
        expanded.set([]);
        query.set('');
      }),
    );
  });
  // Only reachable, expanded directories own a subscription.
  effect(() => {
    const sid = options.sessionId();
    const browsing = options.active() && !query().trim();
    const opened = new Set(expanded());
    const previous = untracked(reads);
    const keep = new Map<string, ReturnType<typeof watchDirectory>>();
    function visit(path: WorkspacePath | null) {
      const id = path?.bytesBase64 ?? '';
      const read = previous.get(id) ?? untracked(() => watchDirectory(host, sid!, path));
      keep.set(id, read);
      for (const entry of read.entries()) {
        if (entry.kind === 'directory' && opened.has(entry.path.bytesBase64)) visit(entry.path);
      }
    }
    if (sid && browsing) visit(null);
    for (const [id, read] of previous) if (!keep.has(id)) read.close();
    if (previous.size !== keep.size || [...keep.keys()].some((id) => !previous.has(id)))
      reads.set(keep);
  });
  cleanup(() => untracked(closeAll));

  const searchGeneration = signal(0);
  effect(() => {
    const q = query().trim();
    const sid = options.sessionId();
    const active = options.active();
    searchGeneration();
    batch(() => {
      matches.set([]);
      closedResults.set(new Set());
      searchError.set('');
      searching.set(!!(sid && active && q));
    });
    if (!sid || !active || !q) return;
    let live = true;
    let stream: { close(): Promise<void> } | null = null;
    cleanup(() => {
      live = false;
      void stream?.close();
    });
    void (async () => {
      try {
        const sub = await host.subscribe('agent', 'fileCandidates', {
          target: { kind: 'session', sessionId: sid },
          directory: null,
          query: q,
        });
        if (!live) {
          await sub.close();
          return;
        }
        stream = sub;
        const rows: AgentFileEntry[] = [];
        let first = true;
        for (;;) {
          const page = await sub.next();
          if (!live || !page) break;
          for (const entry of page.entries) if (entry.kind === 'file') rows.push(entry);
          if (first && rows.length) {
            matches.set(rows.slice());
            first = false;
          }
        }
        if (live) matches.set(rows);
      } catch (error) {
        if (live) searchError.set(errorText(error, 'File search failed.'));
      } finally {
        if (live) {
          searching.set(false);
          const finished = stream;
          stream = null;
          await finished?.close();
        }
      }
    })();
  });

  const results = computed(() => pathTree(matches(), (e) => e.path, host.pathLabel));
  const resultFiles = computed(() => new Set(matches().map((e) => e.path.bytesBase64)));
  const browse = computed(() => {
    const dirs = reads();
    const files = new Set<string>();
    const notes = new Map<string, string>();
    function content(id: string): TreeItem[] {
      const dir = dirs.get(id);
      if (!dir) return [];
      const rows = dir.entries().map((entry): TreeItem => {
        const key = entry.path.bytesBase64;
        const label = basenameLabel(host.pathLabel(entry.path));
        if (entry.kind === 'directory') {
          return { id: key, label, expandable: true, children: content(key) };
        }
        if (entry.kind === 'file') files.add(key);
        else notes.set(key, entry.kind === 'symlink' ? tr('Link') : tr('Unsupported'));
        return { id: key, label, disabled: entry.kind !== 'file' };
      });
      rows.sort(
        (a, b) => Number(!!b.expandable) - Number(!!a.expandable) || a.label.localeCompare(b.label),
      );
      if (dir.next() && !dir.error())
        rows.push({
          id: 'more:' + id + ':' + dir.next()!.after.bytesBase64,
          label: tr('Loading files…'),
          disabled: true,
        });
      return rows;
    }
    return { items: content(''), files, notes };
  });
  const filtering = () => !!query().trim();
  function open(id: string) {
    const sid = options.sessionId();
    if (!sid || !options.active() || !(filtering() ? resultFiles() : browse().files).has(id))
      return;
    const path = { bytesBase64: id };
    options.openFile({
      sessionId: sid,
      path,
      parent: parentPathOf(path),
      title: host.pathLabel(path),
    });
  }
  return {
    sessionId: options.sessionId,
    query,
    open,
    note: (id: string) => (filtering() ? undefined : browse().notes.get(id)),
    items: () => (filtering() ? results().items : browse().items),
    expanded: () =>
      filtering() ? results().folders.filter((id) => !closedResults().has(id)) : expanded(),
    setExpanded(ids: string[]) {
      if (filtering()) {
        const set = new Set(ids);
        closedResults.set(new Set(results().folders.filter((id) => !set.has(id))));
      } else expanded.set(ids);
    },
    loading: () => (filtering() ? searching() : reads().get('')?.loading()),
    error: () =>
      filtering()
        ? searchError()
        : ([...reads().values()].find((dir) => dir.error())?.error() ?? ''),
    demand(id: string) {
      const dir = id.split(':')[1]!;
      reads().get(dir)?.more();
    },
    refresh() {
      if (filtering()) searchGeneration.set(searchGeneration() + 1);
      else for (const dir of reads().values()) dir.refresh();
    },
  };
}
