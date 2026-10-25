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

export type WorktreeInitialization = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';

export interface WorktreeProjectConfig {
  defaultMode?: 'main' | 'new';
  setupScript?: string;
  cleanupScript?: string;
}

export interface WorktreeConfig {
  rootDirectory: string;
  projects: Record<string, WorktreeProjectConfig>;
}

export interface WorktreeInfo {
  /** Durable creation identity, used to observe a checkout before its Session exists. */
  operationId?: string;
  projectId: string;
  path: string;
  name: string;
  branch?: string;
  head: string;
  isMain: boolean;
  managed: boolean;
  available: boolean;
  locked: boolean;
  sessionCount: number;
  initialization?: WorktreeInitialization;
  log?: string;
}

export interface WorktreeProject {
  id: string;
  name: string;
  mainPath: string;
  config: WorktreeProjectConfig;
  worktrees: WorktreeInfo[];
}

export interface WorktreeSnapshot {
  config: WorktreeConfig;
  projects: WorktreeProject[];
}

export type WorktreeMutation =
  | { kind: 'configure'; projectId?: undefined; config: Pick<WorktreeConfig, 'rootDirectory'> }
  | { kind: 'configure'; projectId: string; config: WorktreeProjectConfig }
  | {
      kind: 'create';
      projectId: string;
      operationId: string;
      description: string;
      sourcePath?: string;
    }
  | {
      kind: 'resolve_preparation';
      projectId: string;
      operationId: string;
      decision: 'main' | 'cancel';
    }
  | { kind: 'initialize'; projectId: string; path: string; skip?: boolean }
  | { kind: 'remove'; projectId: string; path: string; confirmation?: string };

export type WorktreeMutationResult =
  | { kind: 'configured' }
  | { kind: 'preparation_resolved' }
  | { kind: 'worktree'; worktree: WorktreeInfo }
  | { kind: 'cleanup_failed'; path: string; log: string; confirmation: string }
  | { kind: 'removed'; path: string };

export type TaskWorktreeSelection =
  | { kind: 'main' }
  | { kind: 'new' }
  | { kind: 'existing'; path: string };

/** Host-validated ability to fork from a Session's current checkout. */
export interface WorktreeBranchWorkspace {
  path: string;
  canCreate: boolean;
}

/** Host-owned preparation projection; Clients never derive it from Git discovery. */
export type WorktreePreparation =
  | { phase: 'inactive' }
  | { phase: 'preparing' }
  | { phase: 'checkout'; path: string }
  | { phase: 'initializing'; path: string }
  | { phase: 'finalizing'; path: string }
  | { phase: 'blocked'; path: string };

/** Absence of this blocker means workspace initialization does not prevent sending. */
export interface WorktreeBlocker {
  kind: 'worktree_initialization';
  path: string;
}
