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

import { createHash } from 'node:crypto';
import {
  type GitoxideHelperInvocationCapability,
  requireGitoxideHelperArtifactIdentityInternal,
  requireGitoxideHelperOperationsInternal,
} from './gitoxide-helper-artifact-authority-internal.js';
import {
  createCandidateWithGitoxideHelperInternal,
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
  importSourceHeadWithGitoxideHelperInternal,
  verifySourceImportWithGitoxideHelperInternal,
  inspectCanonicalRepositoryWithGitoxideHelperInternal,
  readTreeFileWithGitoxideHelperInternal,
  reopenRepositoryWithGitoxideHelperInternal,
  type GitoxideCandidateNoChangeV1,
  type GitoxideCandidatePublishedV1,
  type GitoxideSourceImportObservationV1,
  type GitoxideTreeFileReadV1,
  type GitoxideTreeFileAbsentV1,
  type GitoxideRepositoryRejectionV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideRepositoryAdmissionCapability {
  readonly kind: 'gitoxide_repository_admission_capability_v1';
}

export interface GitoxideAcceptedRepositoryCapability {
  readonly kind: 'gitoxide_accepted_repository_capability_v1';
}

export interface GitoxideCandidateOutcomeCapability {
  readonly kind: 'gitoxide_candidate_outcome_capability_v1';
}

export interface GitoxideRepositoryAdmissionStateInternal {
  readonly protocolVersion: 1;
  readonly repositoryPath: string;
  readonly objectFormat: 'sha1';
  readonly headCommitOid: string;
  readonly headTreeOid: string;
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly managedTreePolicyVersion: 3;
}

const MANAGED_TREE_POLICY_VERSION = 3 as const;
const ACCEPTED_REPOSITORY_REF = 'refs/maka/accepted' as const;

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

interface AcceptedRepositoryCapabilityRecord {
  readonly importObservation?: Readonly<GitoxideSourceImportObservationV1>;
  readonly acceptedRepositoryOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly managedTreePolicyVersion: 3;
}

interface CandidateOutcomeCapabilityRecord {
  readonly candidateOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly repositoryPath: string;
  readonly acceptedRef: string;
  readonly objectFormat: 'sha1';
  readonly managedTreePolicyVersion: 3;
  readonly helperArtifactSha256: `sha256:${string}`;
  readonly disposition: 'published' | 'no_change';
  readonly operationId: string;
  readonly requestDigestSha256: string;
  readonly resultContentSha256: `sha256:${string}`;
  readonly baseCommitOid: string;
  readonly baseTreeOid: string;
  readonly candidateCommitOid: string;
  readonly candidateTreeOid: string;
  readonly candidateRef: string;
  readonly resultBlobOid: string;
  readonly path: string;
}

const admissions = new WeakMap<object, AdmissionCapabilityRecord>();
const acceptedRepositories = new WeakMap<object, AcceptedRepositoryCapabilityRecord>();
const candidateOutcomes = new WeakMap<object, CandidateOutcomeCapabilityRecord>();

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

interface AdmittedImportInput {
  readonly requestFingerprint?: `sha256:${string}`;
  readonly admissionOwnerToken: object;
  readonly repositoryCapability: GitoxideRepositoryAdmissionCapability;
  readonly acceptedRepositoryOwnerToken: object;
  readonly destinationRepositoryPath: string;
  readonly abortSignal?: AbortSignal;
}

export function importAdmittedGitoxideRepositoryInternal(input: AdmittedImportInput) {
  return observeAdmittedImport(input, importSourceHeadWithGitoxideHelperInternal);
}

/** Read-only recovery after publication; partial or changed destinations are never repaired. */
export function verifyAdmittedGitoxideImportInternal(input: AdmittedImportInput) {
  return observeAdmittedImport(input, verifySourceImportWithGitoxideHelperInternal);
}

async function observeAdmittedImport(
  input: AdmittedImportInput,
  observe: typeof importSourceHeadWithGitoxideHelperInternal,
): Promise<
  GitoxideSourceImportObservationV1 & {
    readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  }
> {
  input = { ...input };
  const admission = requireAdmissionRecord(input.admissionOwnerToken, input.repositoryCapability);
  const source = admission.state;
  requireGitoxideHelperOperationsInternal(
    admission.invocationOwnerToken,
    admission.helperCapability,
    ['create_candidate', 'read_tree_file'],
  );
  const result = await observe({
    invocationOwnerToken: admission.invocationOwnerToken,
    capability: admission.helperCapability,
    sourceRepositoryPath: source.repositoryPath,
    expectedSourceHeadCommitOid: source.headCommitOid,
    requestFingerprint: input.requestFingerprint,
    destinationRepositoryPath: input.destinationRepositoryPath,
    baselineRef: ACCEPTED_REPOSITORY_REF,
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
  const acceptedRepositoryCapability = issueAcceptedRepositoryCapability({
    importObservation: Object.freeze({ ...result }),
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
    invocationOwnerToken: admission.invocationOwnerToken,
    helperCapability: admission.helperCapability,
    repositoryPath: input.destinationRepositoryPath,
    acceptedRef: result.baselineRef,
    acceptedCommitOid: result.baselineCommitOid,
    acceptedTreeOid: result.baselineTreeOid,
    managedTreePolicyVersion: result.managedTreePolicyVersion,
  });
  return Object.freeze({ ...result, acceptedRepositoryCapability });
}

/** Read only owner-issued evidence; a caller-supplied import response is not authority. */
export function requireGitoxideImportedRepositoryInternal(
  ownerToken: object,
  capability: GitoxideAcceptedRepositoryCapability,
) {
  const record = requireAcceptedRepositoryRecord(ownerToken, capability);
  if (!record.importObservation)
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  const artifact = requireGitoxideHelperArtifactIdentityInternal(
    record.invocationOwnerToken,
    record.helperCapability,
  );
  return Object.freeze({
    ...record.importObservation,
    repositoryPath: record.repositoryPath,
    helperArtifactSha256: artifact.sha256,
  });
}

/** Reissues a process-local handle only after checking the caller's durable accepted identity. */
export async function reopenGitoxideRepositoryInternal(input: {
  invocationOwnerToken: object;
  helperCapability: GitoxideHelperInvocationCapability;
  acceptedRepositoryOwnerToken: object;
  repositoryPath: string;
  acceptedCommitOid: string;
  acceptedTreeOid: string;
  abortSignal?: AbortSignal;
}): Promise<GitoxideAcceptedRepositoryCapability> {
  requireGitoxideHelperOperationsInternal(input.invocationOwnerToken, input.helperCapability, [
    'reopen_repository',
    'create_candidate',
    'read_tree_file',
  ]);
  await reopenRepositoryWithGitoxideHelperInternal({
    ...input,
    capability: input.helperCapability,
  });
  input.abortSignal?.throwIfAborted();
  return issueAcceptedRepositoryCapability({
    acceptedRepositoryOwnerToken: input.acceptedRepositoryOwnerToken,
    invocationOwnerToken: input.invocationOwnerToken,
    helperCapability: input.helperCapability,
    repositoryPath: input.repositoryPath,
    acceptedRef: ACCEPTED_REPOSITORY_REF,
    acceptedCommitOid: input.acceptedCommitOid,
    acceptedTreeOid: input.acceptedTreeOid,
    managedTreePolicyVersion: MANAGED_TREE_POLICY_VERSION,
  });
}

interface GitoxideCandidateInput {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly operationId: string;
  readonly path: string;
  readonly content: string;
  readonly abortSignal?: AbortSignal;
}

export function createGitoxideCandidateInternal(input: GitoxideCandidateInput) {
  return obtainGitoxideCandidateInternal(input, false);
}

/** Recovery may reissue a proof, but must not create missing publication evidence. */
export function verifyExistingGitoxideCandidateInternal(input: GitoxideCandidateInput) {
  return obtainGitoxideCandidateInternal(input, true);
}

async function obtainGitoxideCandidateInternal(
  original: GitoxideCandidateInput,
  requireExisting: boolean,
): Promise<
  | (GitoxideCandidatePublishedV1 & {
      readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
    })
  | (GitoxideCandidateNoChangeV1 & {
      readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
    })
> {
  const input = { ...original };
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  if (
    typeof input.operationId !== 'string' ||
    input.operationId.length === 0 ||
    Buffer.byteLength(input.operationId, 'utf8') > 1024
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const candidateRef = `refs/maka/candidates/${createHash('sha256').update(input.operationId).digest('hex')}`;
  const result = await createCandidateWithGitoxideHelperInternal({
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedRef: managed.acceptedRef,
    expectedBaseCommitOid: managed.acceptedCommitOid,
    expectedBaseTreeOid: managed.acceptedTreeOid,
    candidateRef,
    path: input.path,
    content: input.content,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
    ...(requireExisting ? { requireExisting: true as const } : {}),
  });
  if (result.kind === 'candidate_rejected') {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_managed_repository_base_mismatch',
    );
  }
  const helperArtifactIdentity = requireGitoxideHelperArtifactIdentityInternal(
    managed.invocationOwnerToken,
    managed.helperCapability,
  );
  const candidateOutcomeCapability = Object.freeze({
    kind: 'gitoxide_candidate_outcome_capability_v1' as const,
  });
  candidateOutcomes.set(
    candidateOutcomeCapability,
    Object.freeze({
      candidateOwnerToken: input.candidateOwnerToken,
      acceptedRepositoryCapability: input.acceptedRepositoryCapability,
      repositoryPath: managed.repositoryPath,
      acceptedRef: managed.acceptedRef,
      objectFormat: 'sha1' as const,
      managedTreePolicyVersion: managed.managedTreePolicyVersion,
      helperArtifactSha256: helperArtifactIdentity.sha256,
      disposition:
        result.kind === 'candidate_published' ? ('published' as const) : ('no_change' as const),
      operationId: input.operationId,
      requestDigestSha256: result.requestDigestSha256,
      resultContentSha256:
        `sha256:${createHash('sha256').update(input.content, 'utf8').digest('hex')}` as const,
      baseCommitOid: result.baseCommitOid,
      baseTreeOid: result.baseTreeOid,
      candidateCommitOid: result.candidateCommitOid,
      candidateTreeOid: result.candidateTreeOid,
      candidateRef: result.candidateRef,
      resultBlobOid: result.resultBlobOid,
      path: result.path,
    }),
  );
  return Object.freeze({ ...result, candidateOutcomeCapability });
}

interface AcceptedTreeFileReadInput {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly path: string;
  readonly abortSignal?: AbortSignal;
}

export function readGitoxideTreeFileInternal(
  input: AcceptedTreeFileReadInput & { readonly allowMissing: true },
): Promise<GitoxideTreeFileReadV1 | GitoxideTreeFileAbsentV1>;
export function readGitoxideTreeFileInternal(
  input: AcceptedTreeFileReadInput,
): Promise<GitoxideTreeFileReadV1>;
export async function readGitoxideTreeFileInternal(
  original: AcceptedTreeFileReadInput & { readonly allowMissing?: boolean },
): Promise<GitoxideTreeFileReadV1 | GitoxideTreeFileAbsentV1> {
  const input = { ...original };
  const managed = requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const request = {
    invocationOwnerToken: managed.invocationOwnerToken,
    capability: managed.helperCapability,
    repositoryPath: managed.repositoryPath,
    acceptedCommitOid: managed.acceptedCommitOid,
    path: input.path,
    managedTreePolicyVersion: managed.managedTreePolicyVersion,
    abortSignal: input.abortSignal,
  };
  const result =
    input.allowMissing === true
      ? await readTreeFileWithGitoxideHelperInternal({ ...request, allowMissing: true })
      : await readTreeFileWithGitoxideHelperInternal(request);
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

/** Exposes immutable identity, never the invocation capability or mutable owner state. */
export function requireGitoxideAcceptedIdentityInternal(
  ownerToken: object,
  capability: GitoxideAcceptedRepositoryCapability,
) {
  const record = requireAcceptedRepositoryRecord(ownerToken, capability);
  const artifact = requireGitoxideHelperArtifactIdentityInternal(
    record.invocationOwnerToken,
    record.helperCapability,
  );
  return Object.freeze({
    repositoryPath: record.repositoryPath,
    helperArtifactSha256: artifact.sha256,
    baseCommitOid: record.acceptedCommitOid,
    baseTreeOid: record.acceptedTreeOid,
  });
}

export function requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal(input: {
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly candidateOwnerToken: object;
  readonly candidateOutcomeCapability: GitoxideCandidateOutcomeCapability;
}): Readonly<
  Omit<CandidateOutcomeCapabilityRecord, 'candidateOwnerToken' | 'acceptedRepositoryCapability'>
> {
  requireAcceptedRepositoryRecord(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const record = candidateOutcomes.get(input.candidateOutcomeCapability);
  if (
    !record ||
    record.candidateOwnerToken !== input.candidateOwnerToken ||
    record.acceptedRepositoryCapability !== input.acceptedRepositoryCapability
  ) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  const {
    candidateOwnerToken: _candidateOwner,
    acceptedRepositoryCapability: _acceptedCapability,
    ...proof
  } = record;
  return Object.freeze(proof);
}

function issueAcceptedRepositoryCapability(
  record: AcceptedRepositoryCapabilityRecord,
): GitoxideAcceptedRepositoryCapability {
  const capability = Object.freeze({
    kind: 'gitoxide_accepted_repository_capability_v1' as const,
  });
  acceptedRepositories.set(capability, Object.freeze(record));
  return capability;
}

function requireAcceptedRepositoryRecord(
  ownerToken: object,
  capability: GitoxideAcceptedRepositoryCapability,
): AcceptedRepositoryCapabilityRecord {
  const record = acceptedRepositories.get(capability);
  if (!record || record.acceptedRepositoryOwnerToken !== ownerToken) {
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
