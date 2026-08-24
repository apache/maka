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

export const SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION = 1 as const;

const SUBAGENT_WORKTREE_LEASE_PATTERN = /^subagent_worktree_[a-f0-9]{32}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_PATH_CHARS = 16_384;
const MAX_BRANCH_CHARS = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Immutable workspace ownership attached to a linked child Session.
 *
 * The Session remains the runtime identity. This binding records the
 * host-managed filesystem lease that gives the child an isolated Git worktree
 * without teaching the graph scheduler about Git.
 */
export interface SubagentWorkspaceBinding {
  schemaVersion: typeof SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION;
  kind: 'git_worktree';
  leaseId: string;
  gitCommonDir: string;
  worktreePath: string;
  /** Host-owned lease branch; the child may check out another branch inside the leased worktree. */
  branch: string;
  baseCommit: string;
}

export interface ProvisionSubagentWorktreeInput {
  leaseId: string;
  sourceSessionId: string;
  sourceCwd: string;
  sourceProjectId?: string | null;
}

export interface SubagentWorktreeExecutor {
  /** Whether the current source project can back an isolated Git worktree. */
  isAvailable(
    input: Pick<ProvisionSubagentWorktreeInput, 'sourceCwd' | 'sourceProjectId'>,
  ): Promise<boolean>;
  provision(input: ProvisionSubagentWorktreeInput): Promise<SubagentWorkspaceBinding>;
  ensure(binding: SubagentWorkspaceBinding): Promise<void>;
  /** Capture the complete workspace delta relative to the durable base commit. */
  capturePatch(binding: SubagentWorkspaceBinding): Promise<Uint8Array>;
  /** Reconcile the private worktree root against the bindings still owned by live Sessions. */
  recover(liveBindings: readonly SubagentWorkspaceBinding[]): Promise<void>;
  /** Permanently release one Host-owned worktree lease. */
  retire(binding: SubagentWorkspaceBinding): Promise<void>;
}

export function isSubagentWorkspaceBinding(value: unknown): value is SubagentWorkspaceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const keys = Object.keys(binding).sort();
  const expected = [
    'baseCommit',
    'branch',
    'gitCommonDir',
    'kind',
    'leaseId',
    'schemaVersion',
    'worktreePath',
  ].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    binding.schemaVersion === SUBAGENT_WORKSPACE_BINDING_SCHEMA_VERSION &&
    binding.kind === 'git_worktree' &&
    typeof binding.leaseId === 'string' &&
    SUBAGENT_WORKTREE_LEASE_PATTERN.test(binding.leaseId) &&
    isBoundedText(binding.gitCommonDir, MAX_PATH_CHARS) &&
    isBoundedText(binding.worktreePath, MAX_PATH_CHARS) &&
    isBoundedText(binding.branch, MAX_BRANCH_CHARS) &&
    !binding.branch.startsWith('-') &&
    typeof binding.baseCommit === 'string' &&
    GIT_COMMIT_PATTERN.test(binding.baseCommit)
  );
}

function isBoundedText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxChars &&
    !CONTROL_CHARACTERS.test(value)
  );
}
