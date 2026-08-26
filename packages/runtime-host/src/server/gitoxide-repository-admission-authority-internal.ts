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
  GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL,
  importSourceHeadWithGitoxideHelperInternal,
  inspectCanonicalRepositoryWithGitoxideHelperInternal,
  type GitoxideSourceImportObservationV1,
  type GitoxideRepositoryRejectionV1,
} from './gitoxide-helper-invocation-internal.js';

export interface GitoxideRepositoryAdmissionCapability {
  readonly kind: 'gitoxide_repository_admission_capability_v1';
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
  constructor(readonly code: 'gitoxide_repository_admission_capability_invalid') {
    super('Gitoxide repository admission capability is invalid');
    this.name = 'GitoxideRepositoryAdmissionAuthorityError';
  }
}

interface AdmissionCapabilityRecord {
  readonly admissionOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly helperCapability: GitoxideHelperInvocationCapability;
  readonly state: GitoxideRepositoryAdmissionStateInternal;
}

const admissions = new WeakMap<object, AdmissionCapabilityRecord>();

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
  readonly destinationRepositoryPath: string;
  readonly baselineRef: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideSourceImportObservationV1> {
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
  return result;
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
