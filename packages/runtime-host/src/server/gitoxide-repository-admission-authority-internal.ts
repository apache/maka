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

import {
  type GitoxideHelperInvocationCapability,
  requireGitoxideHelperArtifactIdentityInternal,
} from './gitoxide-helper-artifact-authority-internal.js';
import {
  createSuccessorWithGitoxideHelperInternal,
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
  importSourceHeadWithGitoxideHelperInternal,
  inspectCanonicalRepositoryWithGitoxideHelperInternal,
  materializeProjectionWithGitoxideHelperInternal,
  observeProjectionWithGitoxideHelperInternal,
  readTreeFileWithGitoxideHelperInternal,
  type GitoxideProjectionMaterializedV1,
  type GitoxideProjectionObservationV1,
  type GitoxideSourceImportObservationV1,
  type GitoxideSuccessorPublishedV1,
  type GitoxideTreeFileReadV1,
  type GitoxideRepositoryRejectionV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideRepositoryAdmissionCapability {
  readonly kind: 'gitoxide_repository_admission_capability_v1';
}

export interface GitoxideManagedRepositoryCapability {
  readonly kind: 'gitoxide_managed_repository_capability_v1';
}

export interface GitoxideProjectionCapability {
  readonly kind: 'gitoxide_projection_capability_v1';
}

export interface GitoxideRepositoryAdmissionStateInternal {
  readonly protocolVersion: 1;
  readonly repositoryPath: string;
  readonly objectFormat: 'sha1';
  readonly headCommitOid: string;
  readonly headTreeOid: string;
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly managedTreePolicyVersion: 2;
}

const MANAGED_TREE_POLICY_VERSION = 2 as const;

export type GitoxideRepositoryAdmissionResultV1 =
  | {
      readonly kind: 'accepted';
      readonly capability: GitoxideRepositoryAdmissionCapability;
    }
  | GitoxideRepositoryRejectionV1;

export class GitoxideRepositoryAdmissionAuthorityError extends Error {
  constructor(
    readonly code:
      | 'gitoxide_repository_admission_capability_invalid'
      | 'gitoxide_managed_repository_base_mismatch',
  ) {
    super(
      code === 'gitoxide_managed_repository_base_mismatch'
        ? 'Gitoxide managed repository base does not match the accepted commit'
        : 'Gitoxide repository admission capability is invalid',
    );
    this.name = 'GitoxideRepositoryAdmissionAuthorityError';
  }
}

interface AdmissionCapabilityRecord {
  readonly admissionOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly state: GitoxideRepositoryAdmissionStateInternal;
}

interface ManagedRepositoryCapabilityRecord {
  readonly managedRepositoryOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly managedTreePolicyVersion: 2;
}

interface ProjectionCapabilityRecord {
  readonly projectionOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly projectionPath: string;
  readonly managedTreePolicyVersion: 2;
}

const admissions = new WeakMap<object, AdmissionCapabilityRecord>();
const managedRepositories = new WeakMap<object, ManagedRepositoryCapabilityRecord>();
const projections = new WeakMap<object, ProjectionCapabilityRecord>();

export async function admitGitoxideRepositoryInternal(input: {
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly admissionOwnerToken: object;
  readonly repositoryPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideRepositoryAdmissionResultV1> {
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs;
  const { observation, repositoryPath } =
    await inspectCanonicalRepositoryWithGitoxideHelperInternal({
      invocationOwnerToken: input.invocationOwnerToken,
      capability: input.helperCapability,
      repositoryPath: input.repositoryPath,
      deadlineAt,
      abortSignal: input.abortSignal,
    });
  if (observation.kind === 'repository_rejected') return observation;
  const helperArtifactIdentity = requireGitoxideHelperArtifactIdentityInternal(
    input.invocationOwnerToken,
    input.helperCapability,
  );

  const capability = Object.freeze({
    kind: 'gitoxide_repository_admission_capability_v1' as const,
  });
  admissions.set(
    capability,
    Object.freeze({
      admissionOwnerToken: input.admissionOwnerToken,
      invocationOwnerToken: input.invocationOwnerToken,
      helperCapability: input.helperCapability,
      state: Object.freeze({
        protocolVersion: observation.protocolVersion,
        repositoryPath,
        objectFormat: observation.objectFormat,
        headCommitOid: observation.headCommitOid,
        headTreeOid: observation.headTreeOid,
        helperArtifactSha256: helperArtifactIdentity.sha256,
        managedTreePolicyVersion: MANAGED_TREE_POLICY_VERSION,
      }),
    }),
  );
  return Object.freeze({ kind: 'accepted' as const, capability });
}

export function requireGitoxideRepositoryAdmissionInternal(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): GitoxideRepositoryAdmissionStateInternal {
  return requireAdmissionRecord(admissionOwnerToken, capability).state;
}

export async function importAdmittedGitoxideRepositoryInternal(input: {
  readonly admissionOwnerToken: object;
  readonly repositoryCapability: GitoxideRepositoryAdmissionCapability;
  readonly managedRepositoryOwnerToken: object;
  readonly destinationRepositoryPath: string;
  readonly baselineRef: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideSourceImportObservationV1 & {
    readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  }
> {
  const admission = requireAdmissionRecord(input.admissionOwnerToken, input.repositoryCapability);
  const source = admission.state;
  const result = await importSourceHeadWithGitoxideHelperInternal({
    invocationOwnerToken: admission.invocationOwnerToken,
    capability: admission.helperCapability,
    sourceRepositoryPath: source.repositoryPath,
    expectedSourceHeadCommitOid: source.headCommitOid,
    destinationRepositoryPath: input.destinationRepositoryPath,
    baselineRef: input.baselineRef,
    managedTreePolicyVersion: source.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (
    result.sourceHeadCommitOid !== source.headCommitOid ||
    result.sourceTreeOid !== source.headTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const managedRepositoryCapability = issueManagedRepositoryCapability({
    managedRepositoryOwnerToken: input.managedRepositoryOwnerToken,
    invocationOwnerToken: admission.invocationOwnerToken,
    helperCapability: admission.helperCapability,
    repositoryPath: input.destinationRepositoryPath,
    acceptedRef: result.baselineRef,
    acceptedCommitOid: result.baselineCommitOid,
    acceptedTreeOid: result.baselineTreeOid,
    managedTreePolicyVersion: result.managedTreePolicyVersion,
  });
  return Object.freeze({ ...result, managedRepositoryCapability });
}

export async function createGitoxideSuccessorInternal(input: {
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly path: string;
  readonly content: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideSuccessorPublishedV1 & {
    readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  }
> {
  const managed = requireManagedRepositoryRecord(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await createSuccessorWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    expectedBaseCommitOid: managed.acceptedCommitOid,
    targetRef: managed.acceptedRef,
    path: input.path,
    content: input.content,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (result.kind === 'successor_rejected') {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_managed_repository_base_mismatch',
    );
  }
  const managedRepositoryCapability = issueManagedRepositoryCapability({
    ...managed,
    acceptedCommitOid: result.successorCommitOid,
    acceptedTreeOid: result.successorTreeOid,
  });
  return Object.freeze({ ...result, managedRepositoryCapability });
}

export async function materializeGitoxideProjectionInternal(input: {
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly projectionOwnerToken: object;
  readonly destinationPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<
  GitoxideProjectionMaterializedV1 & {
    readonly projectionCapability: GitoxideProjectionCapability;
  }
> {
  const managed = requireManagedRepositoryRecord(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await materializeProjectionWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    destinationPath: input.destinationPath,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== managed.acceptedCommitOid ||
    result.acceptedTreeOid !== managed.acceptedTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const projectionCapability = Object.freeze({
    kind: 'gitoxide_projection_capability_v1' as const,
  });
  projections.set(
    projectionCapability,
    Object.freeze({
      projectionOwnerToken: input.projectionOwnerToken,
      invocationOwnerToken: managed.invocationOwnerToken,
      helperCapability: managed.helperCapability,
      repositoryPath: managed.repositoryPath,
      acceptedCommitOid: managed.acceptedCommitOid,
      acceptedTreeOid: managed.acceptedTreeOid,
      projectionPath: result.destinationPath,
      managedTreePolicyVersion: managed.managedTreePolicyVersion,
    }),
  );
  return Object.freeze({ ...result, projectionCapability });
}

export async function observeGitoxideProjectionInternal(input: {
  readonly projectionOwnerToken: object;
  readonly projectionCapability: GitoxideProjectionCapability;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideProjectionObservationV1> {
  const projection = projections.get(input.projectionCapability);
  if (!projection || projection.projectionOwnerToken !== input.projectionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const result = await observeProjectionWithGitoxideHelperInternal({
    invocationOwnerToken: projection.invocationOwnerToken,
    capability: projection.helperCapability,
    repositoryPath: projection.repositoryPath,
    acceptedCommitOid: projection.acceptedCommitOid,
    projectionPath: projection.projectionPath,
    managedTreePolicyVersion: projection.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== projection.acceptedCommitOid ||
    result.acceptedTreeOid !== projection.acceptedTreeOid ||
    result.projectionPath !== projection.projectionPath
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return result;
}

export async function readGitoxideTreeFileInternal(input: {
  readonly managedRepositoryOwnerToken: object;
  readonly managedRepositoryCapability: GitoxideManagedRepositoryCapability;
  readonly path: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideTreeFileReadV1> {
  const managed = requireManagedRepositoryRecord(
    input.managedRepositoryOwnerToken,
    input.managedRepositoryCapability,
  );
  const result = await readTreeFileWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    path: input.path,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  });
  if (
    result.acceptedCommitOid !== managed.acceptedCommitOid ||
    result.acceptedTreeOid !== managed.acceptedTreeOid
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return result;
}

function issueManagedRepositoryCapability(
  record: ManagedRepositoryCapabilityRecord,
): GitoxideManagedRepositoryCapability {
  const capability = Object.freeze({
    kind: 'gitoxide_managed_repository_capability_v1' as const,
  });
  managedRepositories.set(capability, Object.freeze(record));
  return capability;
}

function requireManagedRepositoryRecord(
  ownerToken: object,
  capability: GitoxideManagedRepositoryCapability,
): ManagedRepositoryCapabilityRecord {
  const record = managedRepositories.get(capability);
  if (!record || record.managedRepositoryOwnerToken !== ownerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return record;
}

function requireAdmissionRecord(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): AdmissionCapabilityRecord {
  const record = admissions.get(capability);
  if (!record || record.admissionOwnerToken !== admissionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return record;
}
