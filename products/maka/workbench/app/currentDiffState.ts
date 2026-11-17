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

import { Buffer } from 'buffer';
import { signal } from 'nsh';
import type { GitArea, GitDiff, WorkspacePath } from '../../../../packages/plugin-sdk/src/index.js';
import type { Host } from './host';
import {
  computeTextDigest,
  type GitCompareSpec as AgentGitCompareSpec,
  type GitHubPullFileDiff as AgentGitHubPullFileDiff,
  type GitHubRepoRef as AgentGitHubRepoRef,
  type GitHubReviewThread as AgentGitHubReviewThread,
} from './reviewState';
import { errorText, type UiText } from './text';

export type DiffAnchor = {
  side: 'old' | 'new';
  line: number;
  endLine?: number;
  nonce?: number;
};

export type CurrentDiffSource =
  | { kind: 'working'; area: GitArea }
  | { kind: 'compare'; spec: AgentGitCompareSpec; label: string }
  | {
      kind: 'pr';
      repo: AgentGitHubRepoRef;
      number: number;
      headSha: string;
      baseSha: string;
      pathString: string;
    };

export type CurrentDiffTarget = {
  sessionId: string;
  area?: GitArea;
  source?: CurrentDiffSource;
  sourceKey?: string;
  digest?: string;
  path: WorkspacePath;
  title: string;
  anchor?: DiffAnchor;
};

export function workspacePathFromUtf8(text: string): WorkspacePath {
  return { bytesBase64: Buffer.from(text, 'utf8').toString('base64') };
}

export function resolveDiffSource(target: CurrentDiffTarget): CurrentDiffSource {
  if (target.source) return target.source;
  return { kind: 'working', area: target.area ?? 'worktree' };
}

export function resolveDiffSourceKey(target: CurrentDiffTarget): string {
  if (target.sourceKey) return target.sourceKey;
  const src = resolveDiffSource(target);
  if (src.kind === 'working') return `working:${src.area}`;
  if (src.kind === 'compare') {
    if (src.spec.kind === 'branch') return `branch:${src.spec.base}`;
    if (src.spec.kind === 'commit') return `commit:${src.spec.oid}`;
    return `range:${src.spec.base}..${src.spec.head}`;
  }
  return `pr:${src.repo.host}/${src.repo.owner}/${src.repo.repo}#${src.number}`;
}

export function currentDiffTargetKey(target: CurrentDiffTarget): string {
  return `${target.sessionId}::${resolveDiffSourceKey(target)}::${target.path.bytesBase64}`;
}

export type DiffState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: UiText }
  | {
      kind: 'text';
      patch: string;
      before: string;
      after: string;
      digest: string;
    }
  | { kind: 'patch_only'; patch: string; digest: string }
  | { kind: 'large' }
  | Exclude<GitDiff, { kind: 'text' }>;

export type CurrentDiffModel = {
  target: CurrentDiffTarget;
  state(): DiffState;
  threads(): AgentGitHubReviewThread[];
  setThreads(next: AgentGitHubReviewThread[]): void;
  anchor(): DiffAnchor | undefined;
  setAnchor(anchor: DiffAnchor | undefined): void;
  position: { x: number; y: number };
  refresh(): Promise<void>;
  dispose(): void;
};

export function createCurrentDiff(
  host: Host,
  target: CurrentDiffTarget,
  initialThreads: AgentGitHubReviewThread[] = [],
): CurrentDiffModel {
  const state = signal<DiffState>({ kind: 'loading' });
  const threads = signal<AgentGitHubReviewThread[]>(initialThreads);
  const anchor = signal<DiffAnchor | undefined>(target.anchor);
  let generation = 0;
  let alive = true;
  let previousPatch: string | undefined;

  const refresh = async () => {
    if (!alive) return;
    const reading = ++generation;
    state.set({ kind: 'loading' });
    const source = resolveDiffSource(target);
    try {
      if (source.kind === 'pr') {
        const prDiff: AgentGitHubPullFileDiff = await host.query(
          'agent',
          'githubPullRequestFileDiff',
          {
            sessionId: target.sessionId,
            repo: source.repo,
            number: source.number,
            path: source.pathString,
            baseSha: source.baseSha,
            headSha: source.headSha,
          },
        );
        if (!alive || reading !== generation) return;
        if (prDiff.kind === 'full') {
          if (previousPatch !== undefined && previousPatch !== prDiff.patch) {
            model.position = { x: 0, y: 0 };
          }
          previousPatch = prDiff.patch;
          state.set({
            kind: 'text',
            patch: prDiff.patch,
            before: prDiff.before,
            after: prDiff.after,
            digest: target.digest || computeTextDigest(prDiff.patch),
          });
        } else if (prDiff.kind === 'patch_only') {
          if (previousPatch !== undefined && previousPatch !== prDiff.patch) {
            model.position = { x: 0, y: 0 };
          }
          previousPatch = prDiff.patch;
          state.set({
            kind: 'patch_only',
            patch: prDiff.patch,
            digest: target.digest || computeTextDigest(prDiff.patch),
          });
        } else if (prDiff.kind === 'binary') {
          state.set({ kind: 'binary' });
        } else if (prDiff.kind === 'large') {
          state.set({ kind: 'large' });
        } else {
          state.set({ kind: 'unavailable' });
        }
        return;
      }

      const result: GitDiff | null =
        source.kind === 'compare'
          ? await host.query('agent', 'gitCompareDiff', {
              sessionId: target.sessionId,
              spec: source.spec,
              path: target.path,
            })
          : await host.query('agent', 'gitDiff', {
              sessionId: target.sessionId,
              area: source.area,
              path: target.path,
            });
      if (!alive || reading !== generation) return;
      if (result === null) {
        previousPatch = undefined;
        state.set({ kind: 'unavailable' });
        return;
      }
      if (result.kind === 'text') {
        if (previousPatch !== undefined && previousPatch !== result.patch) {
          model.position = { x: 0, y: 0 };
        }
        previousPatch = result.patch;
        state.set({
          kind: 'text',
          patch: result.patch,
          before: result.before,
          after: result.after,
          digest: target.digest || computeTextDigest(result.patch),
        });
      } else {
        previousPatch = undefined;
        state.set(result);
      }
    } catch (reason) {
      if (alive && reading === generation) {
        state.set({
          kind: 'error',
          message: errorText(reason, 'Could not read file changes.'),
        });
      }
    }
  };

  const model: CurrentDiffModel = {
    target,
    state,
    threads,
    setThreads(next) {
      threads.set(next);
    },
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
