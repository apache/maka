/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with this
 * work for additional information regarding copyright ownership. The ASF
 * licenses this file to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'node:crypto';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  isCanonicalManagedMutationPathV1,
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  type RuntimeEventManagedWorkspaceMutationV2,
} from '@maka/core/runtime-event';
import type { ExecutionWorkspaceAuthority } from '@maka/storage/execution-stores';
import {
  readGitoxideTreeFileInternal,
  requireGitoxideAcceptedIdentityInternal,
  type GitoxideAcceptedRepositoryCapability,
} from './gitoxide-repository-admission-authority-internal.js';

export interface GitoxideMutationAdmissionInput {
  readonly workspaceKey: string;
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
  readonly toolName: 'Write' | 'Edit';
  readonly args: unknown;
  readonly abortSignal?: AbortSignal;
}

/** Read-only pre-T1 observation. SQLite T1, not this object, acquires the reservation. */
export async function prepareGitoxideMutationInternal(
  openAuthority: () => Promise<ExecutionWorkspaceAuthority>,
  original: GitoxideMutationAdmissionInput,
) {
  const input = { ...original };
  input.abortSignal?.throwIfAborted();
  if (input.toolName !== 'Write' && input.toolName !== 'Edit')
    throw new Error('Unsupported managed mutation');
  const args = snapshotArguments(input.args);
  if (!isCanonicalManagedMutationPathV1(args.path))
    throw new Error('Managed mutation requires a canonical path before T1');
  if (
    input.toolName === 'Write'
      ? typeof args.content !== 'string'
      : typeof args.old_string !== 'string' || typeof args.new_string !== 'string'
  )
    throw new Error('Invalid managed mutation arguments');
  if (!input.workspaceKey.trim() || Buffer.byteLength(input.workspaceKey) > 1024)
    throw new Error('Invalid managed workspace key');
  const identity = requireGitoxideAcceptedIdentityInternal(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const id = hash(`maka-managed-files-workspace-v1\0${input.workspaceKey}`).slice(7, 39);
  const authority = await openAuthority();
  const epoch = await authority.readEpoch(`workspace_${id}`, `epoch_${id}`);
  const head = await authority.readHead(`workspace_${id}`, `epoch_${id}`);
  const profile = hash(`maka-gitoxide-import-v3\0${identity.helperArtifactSha256}`);
  if (
    !epoch ||
    !head ||
    epoch.repositoryId !==
      `repository_${hash(`maka-managed-files-repository-v1\0${identity.repositoryPath}`).slice(7, 39)}` ||
    epoch.materializationProfileDigest !== profile ||
    epoch.policyHash !== hash(`maka-managed-files-policy-v3\0${profile}`) ||
    head.commitOid !== identity.baseCommitOid ||
    head.treeOid !== identity.baseTreeOid
  )
    throw new Error('Mutation admission does not match current accepted workspace');
  if (await authority.readReservation(epoch.workspaceInstanceId))
    throw new Error('Managed workspace has an unsettled mutation');
  input.abortSignal?.throwIfAborted();
  const base = await readGitoxideTreeFileInternal({
    ...input,
    path: args.path,
    allowMissing: true,
  });
  input.abortSignal?.throwIfAborted();
  const current = await authority.readHead(epoch.workspaceId, epoch.workspaceEpochId);
  input.abortSignal?.throwIfAborted();
  if (
    !current ||
    current.acceptedEventId !== head.acceptedEventId ||
    current.workspaceVersionId !== head.workspaceVersionId ||
    current.revision !== head.revision ||
    current.commitOid !== head.commitOid ||
    current.treeOid !== head.treeOid ||
    base.acceptedCommitOid !== head.commitOid ||
    base.acceptedTreeOid !== head.treeOid
  )
    throw new Error('Managed workspace advanced during mutation admission');
  const mutation: RuntimeEventManagedWorkspaceMutationV2 = Object.freeze({
    protocol: 'managed_mutation_v2',
    repositoryId: epoch.repositoryId,
    workspaceId: epoch.workspaceId,
    workspaceEpochId: epoch.workspaceEpochId,
    workspaceInstanceId: epoch.workspaceInstanceId,
    objectFormat: 'sha1',
    baseWorkspaceVersionId: head.workspaceVersionId,
    baseAcceptedEventId: head.acceptedEventId,
    baseHeadRevision: head.revision,
    baseCommitOid: head.commitOid,
    baseTreeOid: head.treeOid,
    expectedPath: args.path,
    pathPolicyVersion: 3,
    executionProfileDigest: MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  });
  return Object.freeze({
    toolName: input.toolName,
    args,
    canonicalArgsHash: canonicalToolArgsHash(input.toolName, args),
    mutation,
    baseContent: base.kind === 'tree_file_read' ? base.content : null,
  });
}

function snapshotArguments(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Invalid managed mutation arguments');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4) throw new Error('Invalid managed mutation arguments');
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const key of keys) {
    if (typeof key !== 'string' || !['path', 'content', 'old_string', 'new_string'].includes(key))
      throw new Error('Invalid managed mutation arguments');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      !property?.enumerable ||
      !Object.hasOwn(property, 'value') ||
      typeof property.value !== 'string'
    )
      throw new Error('Invalid managed mutation arguments');
    bytes += Buffer.byteLength(property.value, 'utf8');
    if (bytes > 64 * 1024 * 1024)
      throw new Error('Managed mutation arguments exceed admission budget');
    result[key] = property.value;
  }
  return Object.freeze(result);
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
