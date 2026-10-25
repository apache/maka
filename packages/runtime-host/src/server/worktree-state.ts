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

import type { WorktreeConfig, WorktreeInfo, WorktreeBlocker } from '@maka/core/worktree';
import { WORKTREE_LOG_LIMIT } from './worktree-git.js';

export interface ManagedWorktree {
  operationId: string;
  projectId: string;
  path: string;
  commonDir: string;
  sourcePath: string;
  baseCommit: string;
  branch?: string;
  phase: 'reserved' | 'checked_out' | 'initializing' | 'ready' | 'failed' | 'skipped' | 'removed';
  log: string;
}
export interface WorktreeState {
  version: 2;
  config: WorktreeConfig;
  /** Allocated once per project; names and existing checkout paths never follow renames. */
  projectDirectories: Record<string, string>;
  worktrees: ManagedWorktree[];
  bindings: Record<string, { path: string; commonDir?: string; gitRoot?: string }>;
  preparationDecisions: Record<string, { projectId: string; decision: 'main' | 'cancel' }>;
}

/** One lifecycle describes both checkout ownership and initialization. */
export function worktreeInitialization(
  item: ManagedWorktree,
): NonNullable<WorktreeInfo['initialization']> {
  switch (item.phase) {
    case 'reserved':
    case 'checked_out':
      return 'pending';
    case 'initializing':
      return 'running';
    case 'removed':
      return 'failed';
    default:
      return item.phase;
  }
}

export function interruptWorktree(item: ManagedWorktree): boolean {
  if (item.phase !== 'checked_out' && item.phase !== 'initializing') return false;
  item.phase = 'failed';
  item.log =
    `${item.log}\nPreparation was interrupted. Retry or continue without initialization.`.slice(
      -WORKTREE_LOG_LIMIT,
    );
  return true;
}

type LegacyWorktree = Omit<ManagedWorktree, 'phase'> & {
  created: boolean;
  removed?: boolean;
  initialization: NonNullable<WorktreeInfo['initialization']>;
};
type LegacyWorktreeState = Omit<WorktreeState, 'version' | 'worktrees'> & {
  version: 1;
  worktrees: LegacyWorktree[];
};

/** Upgrade the previous journal once at the storage boundary; never change paths or bindings. */
export function readWorktreeState(value: string): WorktreeState {
  const stored = JSON.parse(value) as WorktreeState | LegacyWorktreeState;
  if (
    (stored.version !== 1 && stored.version !== 2) ||
    !stored.config ||
    !Array.isArray(stored.worktrees) ||
    !stored.bindings
  )
    throw new Error('Invalid worktree journal');
  const state: WorktreeState = {
    ...stored,
    version: 2,
    // Protocol entity IDs may match Object.prototype keys. Restore dictionaries
    // after JSON parsing so those IDs remain ordinary, durable own properties.
    bindings: Object.assign(Object.create(null), stored.bindings),
    projectDirectories: stored.projectDirectories ?? {},
    preparationDecisions: Object.assign(Object.create(null), stored.preparationDecisions),
    worktrees:
      stored.version === 2
        ? stored.worktrees
        : stored.worktrees.map(({ created, removed, initialization, ...item }) => ({
            ...item,
            phase: removed
              ? 'removed'
              : !created
                ? 'reserved'
                : initialization === 'pending'
                  ? 'checked_out'
                  : initialization === 'running'
                    ? 'initializing'
                    : initialization,
          })),
  };
  for (const item of state.worktrees) {
    if (
      ![
        'reserved',
        'checked_out',
        'initializing',
        'ready',
        'failed',
        'skipped',
        'removed',
      ].includes(item.phase)
    )
      throw new Error('Invalid worktree lifecycle');
    interruptWorktree(item);
  }
  return state;
}

export function worktreeBlocker(item: ManagedWorktree | undefined): WorktreeBlocker | undefined {
  if (!item || item.phase === 'ready' || item.phase === 'skipped' || item.phase === 'removed')
    return undefined;
  return { kind: 'worktree_initialization', path: item.path };
}
