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
  prepareGitoxideMutationInternal,
  type GitoxideMutationAdmissionInput,
} from './gitoxide-mutation-admission-internal.js';
import { reconcileAcceptedRefWithGitoxideHelperInternal } from './gitoxide-helper-invocation-internal.js';
import {
  verifyGitoxideCandidateSettlementInternal,
  verifyGitoxideRejectedOperationInternal,
  type GitoxideRejectedOperationInput,
  type GitoxideCandidateSettlementInput,
  type GitoxideNoEffectProof,
} from './gitoxide-candidate-settlement-internal.js';
import {
  openExecutionWorkspaceAuthority,
  type InteractiveExecutionStoresWriter,
  type ExecutionWorkspaceAuthority,
} from '@maka/storage/execution-stores';
import {
  WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
  type WorkspaceBaselineCommitResult,
  type WorkspaceBaselineAuthorityInput,
  type WorkspaceSuccessorAuthorityInput,
} from '@maka/core/workspace-version-authority';
import {
  requireGitoxideImportedRepositoryInternal,
  reopenGitoxideRepositoryInternal,
  type GitoxideAcceptedRepositoryCapability,
} from './gitoxide-repository-admission-authority-internal.js';
import {
  requireGitoxideHelperArtifactIdentityInternal,
  type GitoxideHelperInvocationCapability,
} from './gitoxide-helper-artifact-authority-internal.js';

const owners = new WeakMap<InteractiveExecutionStoresWriter, ReturnType<typeof createOwner>>();

export function createGitoxideWorkspaceBaselineOwnerInternal(
  stores: InteractiveExecutionStoresWriter,
) {
  let owner = owners.get(stores);
  if (!owner) {
    owner = createOwner(stores);
    owners.set(stores, owner);
  }
  return owner;
}

function createOwner(stores: InteractiveExecutionStoresWriter) {
  const proofs = new WeakMap<object, WorkspaceBaselineAuthorityInput>();
  const successors = new WeakMap<object, WorkspaceSuccessorAuthorityInput>();
  const noEffects = new WeakMap<object, GitoxideNoEffectProof>();
  const verifiers = Object.freeze({
    baseline(proof: object) {
      const value = proofs.get(proof);
      if (!value) throw new Error('Unrecognized Gitoxide baseline proof');
      return value;
    },
    successor(proof: object) {
      const value = successors.get(proof);
      if (!value) throw new Error('Unrecognized Gitoxide successor proof');
      return value;
    },
    noEffect(proof: object) {
      const value = noEffects.get(proof);
      if (!value) throw new Error('Unrecognized Gitoxide no-effect proof');
      return value;
    },
  });
  return Object.freeze({
    prepareMutation(input: GitoxideMutationAdmissionInput) {
      return prepareGitoxideMutationInternal(
        () => openExecutionWorkspaceAuthority(stores, verifiers),
        input,
      );
    },
    async acceptRejectedOperation(
      input: GitoxideRejectedOperationInput,
    ): ReturnType<ExecutionWorkspaceAuthority['commitNoEffect']> {
      const verified = await verifyGitoxideRejectedOperationInternal(
        stores,
        () => openExecutionWorkspaceAuthority(stores, verifiers),
        input,
      );
      const proof = Object.freeze({});
      noEffects.set(proof, verified.noEffect);
      return verified.authority.commitNoEffect({
        noEffectOutcome: proof,
        toolOutcome: verified.toolOutcome,
      });
    },
    async acceptUnchangedCandidate(
      input: GitoxideCandidateSettlementInput,
    ): ReturnType<ExecutionWorkspaceAuthority['commitNoEffect']> {
      const verified = await verifyGitoxideCandidateSettlementInternal(
        stores,
        () => openExecutionWorkspaceAuthority(stores, verifiers),
        input,
        'no_change',
      );
      if (verified.kind !== 'no_change') throw new Error('Expected no-change settlement');
      const proof = Object.freeze({});
      noEffects.set(proof, verified.noEffect);
      return verified.authority.commitNoEffect({
        noEffectOutcome: proof,
        toolOutcome: verified.toolOutcome,
      });
    },
    async acceptPublishedCandidate(
      input: GitoxideCandidateSettlementInput,
    ): ReturnType<ExecutionWorkspaceAuthority['commitSuccessor']> {
      const verified = await verifyGitoxideCandidateSettlementInternal(
        stores,
        () => openExecutionWorkspaceAuthority(stores, verifiers),
        input,
      );
      const proof = Object.freeze({});
      if (verified.kind !== 'successor') throw new Error('Expected successor settlement');
      successors.set(proof, verified.successor);
      return verified.authority.commitSuccessor({
        candidateOutcome: proof,
        toolOutcome: verified.toolOutcome,
      });
    },
    async reopen(input: {
      workspaceKey: string;
      repositoryPath: string;
      invocationOwnerToken: object;
      helperCapability: GitoxideHelperInvocationCapability;
      acceptedRepositoryOwnerToken: object;
      abortSignal?: AbortSignal;
    }): Promise<GitoxideAcceptedRepositoryCapability> {
      input = { ...input };
      input.abortSignal?.throwIfAborted();
      if (!input.workspaceKey.trim() || Buffer.byteLength(input.workspaceKey) > 1024)
        throw new Error('Invalid managed workspace key');
      const authority = await openExecutionWorkspaceAuthority(stores, verifiers);
      const id = hash(`maka-managed-files-workspace-v1\0${input.workspaceKey}`).slice(7, 39);
      const workspaceId = `workspace_${id}`;
      const epochId = `epoch_${id}`;
      const epoch = await authority.readEpoch(workspaceId, epochId);
      const head = await authority.readHead(workspaceId, epochId);
      const artifact = requireGitoxideHelperArtifactIdentityInternal(
        input.invocationOwnerToken,
        input.helperCapability,
      );
      const profile = hash(`maka-gitoxide-import-v3\0${artifact.sha256}`);
      const repositoryId = `repository_${hash(`maka-managed-files-repository-v1\0${input.repositoryPath}`).slice(7, 39)}`;
      if (
        !epoch ||
        !head ||
        epoch.repositoryId !== repositoryId ||
        head.repositoryId !== repositoryId ||
        epoch.materializationProfileDigest !== profile ||
        epoch.policyHash !== hash(`maka-managed-files-policy-v3\0${profile}`) ||
        epoch.objectFormat !== 'sha1'
      )
        throw new Error('Managed repository does not match durable workspace identity');
      const version = await authority.readVersion(head.workspaceVersionId);
      if (
        !version ||
        version.acceptedEventId !== head.acceptedEventId ||
        version.commitOid !== head.commitOid ||
        version.treeOid !== head.treeOid ||
        version.repositoryId !== epoch.repositoryId ||
        version.workspaceEpochId !== epochId ||
        version.workspaceId !== workspaceId
      )
        throw new Error('Managed head has no matching accepted version');
      if (version.protocol === 'workspace_version_accepted_v1') {
        const parent = await authority.readVersion(version.parents[0]);
        if (
          !parent ||
          parent.acceptedEventId !== version.baseAcceptedEventId ||
          parent.repositoryId !== epoch.repositoryId ||
          parent.workspaceEpochId !== epochId ||
          parent.workspaceId !== workspaceId
        )
          throw new Error('Managed successor has no matching accepted predecessor');
        await reconcileAcceptedRefWithGitoxideHelperInternal({
          invocationOwnerToken: input.invocationOwnerToken,
          capability: input.helperCapability,
          repositoryPath: input.repositoryPath,
          acceptedCommitOid: head.commitOid,
          acceptedTreeOid: head.treeOid,
          expectedPreviousCommitOid: parent.commitOid,
          abortSignal: input.abortSignal,
        });
      }
      const capability = await reopenGitoxideRepositoryInternal({
        ...input,
        acceptedCommitOid: head.commitOid,
        acceptedTreeOid: head.treeOid,
      });
      // Recheck the same execution-group authority after asynchronous helper work.
      const current = await authority.readHead(workspaceId, epochId);
      input.abortSignal?.throwIfAborted();
      if (
        !current ||
        current.workspaceVersionId !== head.workspaceVersionId ||
        current.acceptedEventId !== head.acceptedEventId ||
        current.revision !== head.revision ||
        current.commitOid !== head.commitOid ||
        current.treeOid !== head.treeOid
      ) {
        throw new Error('Managed workspace advanced during repository reopen');
      }
      return capability;
    },
    async acceptImport(input: {
      workspaceKey: string;
      acceptedRepositoryOwnerToken: object;
      acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
    }): Promise<WorkspaceBaselineCommitResult> {
      if (!input.workspaceKey.trim() || Buffer.byteLength(input.workspaceKey) > 1024) {
        throw new Error('Invalid managed workspace key');
      }
      const imported = requireGitoxideImportedRepositoryInternal(
        input.acceptedRepositoryOwnerToken,
        input.acceptedRepositoryCapability,
      );
      const id = hash(`maka-managed-files-workspace-v1\0${input.workspaceKey}`).slice(7, 39);
      const repositoryId = hash(
        `maka-managed-files-repository-v1\0${imported.repositoryPath}`,
      ).slice(7, 39);
      const materializationProfileDigest = hash(
        `maka-gitoxide-import-v3\0${imported.helperArtifactSha256}`,
      );
      const policyHash = hash(`maka-managed-files-policy-v3\0${materializationProfileDigest}`);
      const proof = Object.freeze({});
      proofs.set(proof, {
        epochOpenedEventId: `workspace-epoch-${id}`,
        baselineAcceptedEventId: `workspace-baseline-${id}`,
        committedAt: 0,
        epoch: {
          repositoryId: `repository_${repositoryId}`,
          workspaceId: `workspace_${id}`,
          workspaceEpochId: `epoch_${id}`,
          workspaceInstanceId: `instance_${id}`,
          mode: 'managed_worktree',
          objectFormat: 'sha1',
          sourceCommitOid: imported.sourceHeadCommitOid,
          sourceTreeOid: imported.sourceTreeOid,
          materializationProfileDigest,
          materializationSemantics: WORKSPACE_MATERIALIZATION_SEMANTICS_V1,
          policyHash,
        },
        baseline: {
          workspaceVersionId: `version_${id}`,
          commitOid: imported.baselineCommitOid,
          treeOid: imported.baselineTreeOid,
          treeDeltaDigest: hash(`maka-gitoxide-baseline-tree-v1\0${imported.baselineTreeOid}`),
          changedFileCount: imported.filesImported,
          deletedFileCount: 0,
        },
      });
      const authority = await openExecutionWorkspaceAuthority(stores, verifiers);
      return authority.commitBaseline(proof);
    },
  });
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
