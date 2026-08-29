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
  WorkspaceBaselineAuthorityInput,
  WorkspaceBaselineCommitResult,
  WorkspaceHeadRecordV1,
  WorkspaceSuccessorAuthorityInput,
} from '@maka/core/workspace-version-authority';
import type { RuntimeEvent } from '@maka/core/runtime-event';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
  rootId: string,
) => Promise<WorkspaceBaselineCommitResult>;
type WorkspaceStorageRootBinder = (rootId: string) => void;
export interface WorkspaceSuccessorCommitInput {
  /** Opaque capability issued by the repository candidate owner. */
  candidateOutcome: object;
  toolOutcome: {
    operationId: string;
    journalEventId: string;
    runtimeEvent: RuntimeEvent;
    committedAt: number;
  };
}
interface VerifiedWorkspaceSuccessorCommitInput {
  successor: WorkspaceSuccessorAuthorityInput;
  toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface WorkspaceSuccessorCommitResult {
  created: boolean;
  /** Historical successor accepted by this operation, not necessarily the current head. */
  committedSuccessor: WorkspaceHeadRecordV1;
  outcomeRuntimeEventSeq: number;
}
export interface ManagedMutationTerminalCommitInput {
  /** Opaque capability issued after the mutation owner proves that no workspace effect occurred. */
  noEffectOutcome: object;
  toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface ManagedMutationNoEffectClaimV1 {
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly workspaceInstanceId: string;
  readonly terminalKind: 'no_workspace_change' | 'operation_failed_no_effect';
}
interface VerifiedManagedMutationTerminalCommitInput {
  noEffect: ManagedMutationNoEffectClaimV1;
  toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
}
export interface ManagedMutationTerminalCommitResult {
  created: boolean;
  outcomeRuntimeEventSeq: number;
}
type ManagedMutationTerminalAuthorityWriter = (
  input: VerifiedManagedMutationTerminalCommitInput,
  rootId: string,
) => Promise<ManagedMutationTerminalCommitResult>;
type WorkspaceSuccessorAuthorityWriter = (
  input: VerifiedWorkspaceSuccessorCommitInput,
  rootId: string,
) => Promise<WorkspaceSuccessorCommitResult>;
type WorkspaceSuccessorCandidateVerifier = (
  candidateOutcome: object,
) => WorkspaceSuccessorAuthorityInput;
type ManagedMutationNoEffectVerifier = (noEffectOutcome: object) => ManagedMutationNoEffectClaimV1;
type WorkspaceHeadReader = (
  workspaceId: string,
  workspaceEpochId: string,
) => Promise<WorkspaceHeadRecordV1 | undefined>;
export interface ManagedMutationReservationRecordV1 {
  readonly workspaceInstanceId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly baseWorkspaceVersionId: string;
  readonly baseAcceptedEventId: string;
  readonly baseHeadRevision: number;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly expectedPath: string;
  readonly executionProfileDigest: string;
  readonly reservedAt: number;
}
type ManagedMutationReservationReader = (
  workspaceInstanceId: string,
) => Promise<ManagedMutationReservationRecordV1 | undefined>;

interface WorkspaceBaselineAuthorityRegistration {
  readonly writer: WorkspaceBaselineAuthorityWriter;
  readonly successorWriter: WorkspaceSuccessorAuthorityWriter;
  candidateVerifier?: WorkspaceSuccessorCandidateVerifier;
  noEffectVerifier?: ManagedMutationNoEffectVerifier;
  readonly terminalWriter: ManagedMutationTerminalAuthorityWriter;
  readonly readHead: WorkspaceHeadReader;
  readonly readActiveManagedMutation: ManagedMutationReservationReader;
  readonly bindStorageRoot: WorkspaceStorageRootBinder;
  boundRootId?: string;
}

const workspaceBaselineAuthorityWriters = new WeakMap<
  object,
  WorkspaceBaselineAuthorityRegistration
>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  writer: WorkspaceBaselineAuthorityWriter,
  successorWriter: WorkspaceSuccessorAuthorityWriter,
  terminalWriter: ManagedMutationTerminalAuthorityWriter,
  bindStorageRoot: WorkspaceStorageRootBinder,
  readHead: WorkspaceHeadReader,
  readActiveManagedMutation: ManagedMutationReservationReader,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  workspaceBaselineAuthorityWriters.set(store, {
    writer,
    successorWriter,
    terminalWriter,
    readHead,
    readActiveManagedMutation,
    bindStorageRoot,
  });
}

export function readActiveManagedMutationInternal(
  store: object,
  workspaceInstanceId: string,
): Promise<ManagedMutationReservationRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation reservation reader is unavailable');
  return registration.readActiveManagedMutation(workspaceInstanceId);
}

export function readWorkspaceHeadInternal(
  store: object,
  workspaceId: string,
  workspaceEpochId: string,
): Promise<WorkspaceHeadRecordV1 | undefined> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority reader is unavailable');
  return registration.readHead(workspaceId, workspaceEpochId);
}

/**
 * Storage-internal authority seam. This module is deliberately absent from the
 * @maka/storage package exports. The schema-9 reader, migration, and projection
 * rebuild remain supported even though no production baseline writer is
 * currently composed. Focused persistence tests use this seam to prove the
 * SQLite transaction and historical read contract.
 */
export function commitWorkspaceBaselineInternal(
  store: object,
  input: WorkspaceBaselineAuthorityInput,
): Promise<WorkspaceBaselineCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace baseline authority store has no durable storage-root binding');
  }
  return registration.writer(input, registration.boundRootId);
}

export function commitWorkspaceSuccessorInternal(
  store: object,
  input: WorkspaceSuccessorCommitInput,
): Promise<WorkspaceSuccessorCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace successor authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace successor authority store has no durable storage-root binding');
  }
  if (!registration.candidateVerifier) {
    throw new Error('Workspace successor candidate verifier is unavailable');
  }
  const successor = registration.candidateVerifier(input.candidateOutcome);
  return registration.successorWriter(
    { successor, toolOutcome: input.toolOutcome },
    registration.boundRootId,
  );
}

export function registerWorkspaceSuccessorCandidateVerifierInternal(
  store: object,
  verifier: WorkspaceSuccessorCandidateVerifier,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace successor authority writer is unavailable');
  if (registration.candidateVerifier) {
    throw new Error('Workspace successor candidate verifier is already registered');
  }
  registration.candidateVerifier = verifier;
}

export function registerManagedMutationNoEffectVerifierInternal(
  store: object,
  verifier: ManagedMutationNoEffectVerifier,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation terminal authority writer is unavailable');
  if (registration.noEffectVerifier) {
    throw new Error('Managed mutation no-effect verifier is already registered');
  }
  registration.noEffectVerifier = verifier;
}

export function commitManagedMutationTerminalInternal(
  store: object,
  input: ManagedMutationTerminalCommitInput,
): Promise<ManagedMutationTerminalCommitResult> {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Managed mutation terminal authority writer is unavailable');
  if (!registration.boundRootId) {
    throw new Error('Workspace successor authority store has no durable storage-root binding');
  }
  if (!registration.noEffectVerifier) {
    throw new Error('Managed mutation owner-issued no-effect proof verifier is unavailable');
  }
  if (!input.noEffectOutcome || typeof input.noEffectOutcome !== 'object') {
    throw new Error('Managed mutation terminal requires an owner-issued no-effect proof');
  }
  const noEffect = registration.noEffectVerifier(input.noEffectOutcome);
  return registration.terminalWriter(
    { noEffect, toolOutcome: input.toolOutcome },
    registration.boundRootId,
  );
}

export function bindWorkspaceBaselineAuthorityStoreRootInternal(
  store: object,
  rootId: string,
): void {
  const registration = workspaceBaselineAuthorityWriters.get(store);
  if (!registration) throw new Error('Workspace baseline authority writer is unavailable');
  if (!/^[a-f0-9]{64}$/u.test(rootId)) {
    throw new Error('Invalid durable storage-root identity');
  }
  registration.bindStorageRoot(rootId);
  registration.boundRootId = rootId;
}
