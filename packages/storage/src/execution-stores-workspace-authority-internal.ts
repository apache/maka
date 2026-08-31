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
  registerManagedMutationNoEffectVerifierInternal,
  registerWorkspaceSuccessorCandidateVerifierInternal,
  type ManagedMutationNoEffectClaimV1,
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
  issueNoEffectOutcome(claim: ManagedMutationNoEffectClaimV1): object;
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

interface NoEffectCapabilityRecord extends AuthoritySource {
  readonly ownerToken: object;
  readonly claim: ManagedMutationNoEffectClaimV1;
}

const sources = new WeakMap<object, AuthoritySource>();
const capabilities = new WeakMap<object, AuthorityCapabilityRecord>();
const noEffectCapabilities = new WeakMap<object, NoEffectCapabilityRecord>();

export function registerExecutionStoresWorkspaceMutationSourceInternal(
  stores: object,
  store: object,
  rootId: string,
): void {
  if (sources.has(stores) || !/^[0-9a-f]{64}$/u.test(rootId)) {
    throw new Error('Execution stores workspace mutation source is invalid');
  }
  sources.set(stores, Object.freeze({ store, rootId }));
  registerManagedMutationNoEffectVerifierInternal(store, (capability) => {
    const record = noEffectCapabilities.get(capability);
    if (!record || record.store !== store || record.rootId !== rootId) {
      throw new Error('Managed mutation no-effect proof is invalid');
    }
    return record.claim;
  });
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
    issueNoEffectOutcome: (claim: ManagedMutationNoEffectClaimV1) => {
      const noEffectOutcome = Object.freeze({});
      noEffectCapabilities.set(
        noEffectOutcome,
        Object.freeze({
          ownerToken,
          store,
          rootId: record.rootId,
          claim: structuredClone(claim),
        }),
      );
      return noEffectOutcome;
    },
    commitSuccessor: (input: WorkspaceSuccessorCommitInput) =>
      commitWorkspaceSuccessorInternal(store, input),
    commitTerminal: (input: ManagedMutationTerminalCommitInput) => {
      const noEffect = noEffectCapabilities.get(input.noEffectOutcome);
      if (
        !noEffect ||
        noEffect.ownerToken !== ownerToken ||
        noEffect.store !== store ||
        noEffect.rootId !== record.rootId
      ) {
        throw new Error('Managed mutation no-effect proof is invalid');
      }
      return commitManagedMutationTerminalInternal(store, input);
    },
  });
}
