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

import { realpath } from 'node:fs/promises';
import type { GitoxideHelperInvocationCapability } from './gitoxide-helper-artifact-authority-internal.js';
import {
  inspectRepositoryWithGitoxideHelperInternal,
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
}

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
  const repositoryPath = await realpath(input.repositoryPath);
  const observation = await inspectRepositoryWithGitoxideHelperInternal({
    invocationOwnerToken: input.invocationOwnerToken,
    capability: input.helperCapability,
    repositoryPath,
    abortSignal: input.abortSignal,
  });
  if (observation.kind === 'repository_rejected') return observation;

  const capability = Object.freeze({
    kind: 'gitoxide_repository_admission_capability_v1' as const,
  });
  admissions.set(
    capability,
    Object.freeze({
      admissionOwnerToken: input.admissionOwnerToken,
      state: Object.freeze({
        protocolVersion: observation.protocolVersion,
        repositoryPath,
        objectFormat: observation.objectFormat,
        headCommitOid: observation.headCommitOid,
        headTreeOid: observation.headTreeOid,
      }),
    }),
  );
  return Object.freeze({ kind: 'accepted' as const, capability });
}

export function requireGitoxideRepositoryAdmissionInternal(
  admissionOwnerToken: object,
  capability: GitoxideRepositoryAdmissionCapability,
): GitoxideRepositoryAdmissionStateInternal {
  const state = admissions.get(capability);
  if (!state || state.admissionOwnerToken !== admissionOwnerToken) {
    throw new GitoxideRepositoryAdmissionAuthorityError(
      'gitoxide_repository_admission_capability_invalid',
    );
  }
  return state.state;
}
