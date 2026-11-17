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

import { signal } from 'nsh';
import type { GitArea, GitDiff, WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import { errorText, type UiText } from './text';

export type DiffAnchor = {
  side: 'old' | 'new';
  line: number;
  endLine?: number;
  nonce?: number;
};

export type CurrentDiffTarget = {
  sessionId: string;
  area: GitArea;
  path: WorkspacePath;
  title: string;
  anchor?: DiffAnchor;
};

export type DiffState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: UiText }
  | { kind: 'text'; patch: string; before: string; after: string }
  | Exclude<GitDiff, { kind: 'text' }>;

export type CurrentDiffModel = {
  target: CurrentDiffTarget;
  state(): DiffState;
  anchor(): DiffAnchor | undefined;
  setAnchor(anchor: DiffAnchor | undefined): void;
  position: { x: number; y: number };
  refresh(): Promise<void>;
  dispose(): void;
};

export function createCurrentDiff(host: Host, target: CurrentDiffTarget): CurrentDiffModel {
  const state = signal<DiffState>({ kind: 'loading' });
  const anchor = signal<DiffAnchor | undefined>(target.anchor);
  let generation = 0;
  let alive = true;
  let previous: GitDiff | null | undefined;
  const refresh = async () => {
    if (!alive) return;
    const reading = ++generation;
    state.set({ kind: 'loading' });
    try {
      const result: GitDiff | null = await host.query('agent', 'gitDiff', {
        sessionId: target.sessionId,
        area: target.area,
        path: target.path,
      });
      if (!alive || reading !== generation) return;
      const same =
        previous !== undefined &&
        (result === null
          ? previous === null
          : previous !== null &&
            previous.kind === result.kind &&
            (result.kind !== 'text' ||
              (previous.kind === 'text' && previous.patch === result.patch)));
      if (!same) model.position = { x: 0, y: 0 };
      previous = result;
      state.set(
        result === null
          ? { kind: 'unavailable' }
          : result.kind === 'text'
            ? {
                kind: 'text',
                patch: result.patch,
                before: result.before,
                after: result.after,
              }
            : result,
      );
    } catch (reason) {
      if (alive && reading === generation)
        state.set({ kind: 'error', message: errorText(reason, 'Could not read file changes.') });
    }
  };
  const model: CurrentDiffModel = {
    target,
    state,
    anchor,
    setAnchor(next) {
      anchor.set(next);
    },
    position: { x: 0, y: 0 },
    refresh,
    dispose() {
      alive = false;
      generation += 1;
    },
  };
  void refresh();
  return model;
}
