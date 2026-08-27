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

import type {
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
  WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  adoptWorkspaceBaselineAuthorityStoreRootInternal,
  commitManagedMutationTerminalInternal,
  commitWorkspaceSuccessorInternal,
  readActiveManagedMutationInternal,
  readWorkspaceHeadInternal,
  readWorkspaceVersionInternal,
  registerWorkspaceSuccessorCandidateVerifierInternal,
  type ManagedMutationReservationRecordV1,
  type ManagedMutationTerminalCommitInput,
  type ManagedMutationTerminalCommitResult,
  type WorkspaceSuccessorCommitInput,
  type WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';

export interface ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal {
  readonly kind: 'execution_stores_workspace_mutation_authority_v1';
}

export interface ExecutionStoresWorkspaceMutationAuthorityInternal {
  readHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined>;
  readVersion(workspaceVersionId: string): Promise<WorkspaceVersionRecordV1 | undefined>;
  readActiveMutation(
    workspaceInstanceId: string,
  ): Promise<ManagedMutationReservationRecordV1 | undefined>;
  commitSuccessor(input: WorkspaceSuccessorCommitInput): Promise<WorkspaceSuccessorCommitResult>;
  commitTerminal(
    input: ManagedMutationTerminalCommitInput,
  ): Promise<ManagedMutationTerminalCommitResult>;
}

interface AuthoritySource {
  readonly store: object;
  readonly rootId: string;
}

interface AuthorityCapabilityRecord extends AuthoritySource {
  readonly ownerToken: object;
}

const sources = new WeakMap<object, AuthoritySource>();
const capabilities = new WeakMap<object, AuthorityCapabilityRecord>();

export function registerExecutionStoresWorkspaceMutationSourceInternal(
  stores: object,
  store: object,
  rootId: string,
): void {
  if (sources.has(stores) || !/^[0-9a-f]{64}$/u.test(rootId)) {
    throw new Error('Execution stores workspace mutation source is invalid');
  }
  sources.set(stores, Object.freeze({ store, rootId }));
}

export function issueExecutionStoresWorkspaceMutationAuthorityInternal(input: {
  readonly ownerToken: object;
  readonly stores: object;
  readonly verifyCandidate: (candidateOutcome: object) => WorkspaceSuccessorAuthorityInput;
}): ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal {
  const source = sources.get(input.stores);
  if (!source) throw new Error('Execution stores workspace mutation source is unavailable');
  adoptWorkspaceBaselineAuthorityStoreRootInternal(source.store, source.rootId);
  registerWorkspaceSuccessorCandidateVerifierInternal(source.store, input.verifyCandidate);
  const capability = Object.freeze({
    kind: 'execution_stores_workspace_mutation_authority_v1' as const,
  });
  capabilities.set(
    capability,
    Object.freeze({ ownerToken: input.ownerToken, store: source.store, rootId: source.rootId }),
  );
  return capability;
}

export function requireExecutionStoresWorkspaceMutationAuthorityInternal(
  ownerToken: object,
  capability: ExecutionStoresWorkspaceMutationAuthorityCapabilityInternal,
): ExecutionStoresWorkspaceMutationAuthorityInternal {
  const record = capabilities.get(capability);
  if (!record || record.ownerToken !== ownerToken) {
    throw new Error('Execution stores workspace mutation authority capability is invalid');
  }
  const store = record.store;
  return Object.freeze({
    readHead: (workspaceId: string, workspaceEpochId: string) =>
      readWorkspaceHeadInternal(store, workspaceId, workspaceEpochId),
    readVersion: (workspaceVersionId: string) =>
      readWorkspaceVersionInternal(store, workspaceVersionId),
    readActiveMutation: (workspaceInstanceId: string) =>
      readActiveManagedMutationInternal(store, workspaceInstanceId),
    commitSuccessor: (input: WorkspaceSuccessorCommitInput) =>
      commitWorkspaceSuccessorInternal(store, input),
    commitTerminal: (input: ManagedMutationTerminalCommitInput) =>
      commitManagedMutationTerminalInternal(store, input),
  });
}
