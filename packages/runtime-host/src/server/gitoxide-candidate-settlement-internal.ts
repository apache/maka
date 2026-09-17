/* Licensed to the Apache Software Foundation (ASF) under one or more
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
import { isDeepStrictEqual } from 'node:util';
import { formatSyntheticToolErrorText } from '@maka/runtime/tool-runtime';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import type { WorkspaceSuccessorAuthorityInput } from '@maka/core/workspace-version-authority';
import {
  transformManagedMutation,
  ManagedMutationRejectedError,
} from '@maka/runtime/managed-mutation-transform';
import type {
  ExecutionWorkspaceAuthority,
  InteractiveExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  readGitoxideTreeFileInternal,
  requireGitoxideAcceptedIdentityInternal,
  requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal,
} from './gitoxide-repository-admission-authority-internal.js';

export type GitoxideCandidateSettlementInput = Parameters<
  typeof requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal
>[0] & {
  readonly workspaceKey: string;
  readonly toolOutcome: Parameters<
    ExecutionWorkspaceAuthority['commitSuccessor']
  >[0]['toolOutcome'];
};

export interface GitoxideNoEffectProof {
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly workspaceInstanceId: string;
  readonly terminalKind: 'no_workspace_change' | 'operation_failed_no_effect';
}

export type GitoxideRejectedOperationInput = Omit<
  GitoxideCandidateSettlementInput,
  'candidateOwnerToken' | 'candidateOutcomeCapability'
>;

export async function verifyGitoxideRejectedOperationInternal(
  stores: InteractiveExecutionStoresWriter,
  openAuthority: () => Promise<ExecutionWorkspaceAuthority>,
  original: GitoxideRejectedOperationInput,
) {
  const input = { ...original };
  const identity = requireGitoxideAcceptedIdentityInternal(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const verified = await verifyDurableMutationContext(stores, openAuthority, input, identity);
  let failure: ManagedMutationRejectedError | undefined;
  try {
    transformManagedMutation({
      toolName: verified.call.name as 'Write' | 'Edit',
      canonicalPath: verified.mutation.expectedPath,
      baseContent: verified.base.kind === 'tree_file_read' ? verified.base.content : null,
      args: verified.call.args,
    });
  } catch (error) {
    if (!(error instanceof ManagedMutationRejectedError)) throw error;
    failure = error;
  }
  if (!failure) throw new Error('Operation has no deterministic rejection');
  const response = verified.event.content;
  if (
    response?.kind !== 'function_response' ||
    response.isError !== true ||
    !isDeepStrictEqual(response.result, {
      kind: 'text',
      text: formatSyntheticToolErrorText(failure),
    })
  )
    throw new Error('Rejected outcome does not match the durable operation result');
  return {
    authority: verified.authority,
    toolOutcome: verified.toolOutcome,
    noEffect: {
      operationId: verified.toolOutcome.operationId,
      dispatchEventId: verified.dispatchEvent.id,
      workspaceInstanceId: verified.mutation.workspaceInstanceId,
      terminalKind: 'operation_failed_no_effect' as const,
    },
  };
}

type VerifiedCandidateSettlement = {
  authority: ExecutionWorkspaceAuthority;
  toolOutcome: GitoxideCandidateSettlementInput['toolOutcome'];
} & (
  | { kind: 'successor'; successor: WorkspaceSuccessorAuthorityInput }
  | { kind: 'no_change'; noEffect: GitoxideNoEffectProof }
);

/** Internal composition only. Derive acceptance from durable T1, never a caller's successor descriptor. */
export async function verifyGitoxideCandidateSettlementInternal(
  stores: InteractiveExecutionStoresWriter,
  openAuthority: () => Promise<ExecutionWorkspaceAuthority>,
  original: GitoxideCandidateSettlementInput,
  expectedDisposition: 'published' | 'no_change' = 'published',
): Promise<VerifiedCandidateSettlement> {
  const input = { ...original };
  const candidate = requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal(input);
  if (
    candidate.disposition !== expectedDisposition ||
    candidate.operationId !== input.toolOutcome.operationId
  )
    throw new Error('Candidate disposition does not match settlement for this operation');
  const { authority, epoch, event, dispatchEvent, mutation, call, base, toolOutcome } =
    await verifyDurableMutationContext(stores, openAuthority, input, candidate);
  if (mutation.expectedPath !== candidate.path)
    throw new Error('Candidate does not match durable mutation admission');
  const result = transformManagedMutation({
    toolName: call.name as 'Write' | 'Edit',
    canonicalPath: candidate.path,
    baseContent: base.kind === 'tree_file_read' ? base.content : null,
    args: call.args,
  });
  return finishCandidateSettlement(
    { authority, epoch, event, dispatchEvent, mutation, toolOutcome },
    candidate,
    result,
    expectedDisposition,
  );
}

async function verifyDurableMutationContext(
  stores: InteractiveExecutionStoresWriter,
  openAuthority: () => Promise<ExecutionWorkspaceAuthority>,
  input: GitoxideRejectedOperationInput,
  candidate: ReturnType<typeof requireGitoxideAcceptedIdentityInternal>,
) {
  const toolOutcome = {
    ...input.toolOutcome,
    runtimeEvent: encodeCanonicalRuntimeEvent(input.toolOutcome.runtimeEvent).event,
  };
  if (!input.workspaceKey.trim() || Buffer.byteLength(input.workspaceKey) > 1024)
    throw new Error('Invalid managed workspace key');
  const id = digest(`maka-managed-files-workspace-v1\0${input.workspaceKey}`).slice(7, 39);
  const authority = await openAuthority();
  const epoch = await authority.readEpoch(`workspace_${id}`, `epoch_${id}`);
  const profile = digest(`maka-gitoxide-import-v3\0${candidate.helperArtifactSha256}`);
  if (
    !epoch ||
    epoch.repositoryId !==
      `repository_${digest(`maka-managed-files-repository-v1\0${candidate.repositoryPath}`).slice(7, 39)}` ||
    epoch.materializationProfileDigest !== profile ||
    epoch.policyHash !== digest(`maka-managed-files-policy-v3\0${profile}`)
  )
    throw new Error('Candidate does not match durable workspace identity');
  const event = toolOutcome.runtimeEvent;
  if (!event.runId) throw new Error('Candidate outcome requires a durable run');
  const evidence = await stores.runtimeEventStore.readRuntimeEventsBounded(
    event.sessionId,
    event.runId,
    { maxRecords: 16_384, maxBytes: 32 * 1024 * 1024 },
  );
  if (evidence.status !== 'complete') throw new Error('Candidate T1 evidence exceeds read budget');
  const dispatches = evidence.records.filter(
    (row) => !row.partial && row.actions?.toolDispatch?.operationId === toolOutcome.operationId,
  );
  if (dispatches.length !== 1) throw new Error('Candidate requires one durable T1 dispatch');
  const dispatchEvent = dispatches[0]!;
  const dispatch = dispatchEvent.actions!.toolDispatch!;
  const mutation = dispatch.managedMutation;
  const calls = evidence.records.filter(
    (row) =>
      !row.partial &&
      row.refs?.operationId === toolOutcome.operationId &&
      row.content?.kind === 'function_call',
  );
  const call = calls.length === 1 ? calls[0]!.content : undefined;
  if (
    !mutation ||
    !call ||
    call.kind !== 'function_call' ||
    (call.name !== 'Write' && call.name !== 'Edit') ||
    mutation.repositoryId !== epoch.repositoryId ||
    mutation.workspaceId !== epoch.workspaceId ||
    mutation.workspaceEpochId !== epoch.workspaceEpochId ||
    mutation.workspaceInstanceId !== epoch.workspaceInstanceId ||
    mutation.baseCommitOid !== candidate.baseCommitOid ||
    mutation.baseTreeOid !== candidate.baseTreeOid
  )
    throw new Error('Candidate does not match durable mutation admission');
  // Only a verified tree_file_absent response permits a null base. Missing
  // objects, malformed trees and read errors remain failures, never absence.
  const base = await readGitoxideTreeFileInternal({
    ...input,
    path: mutation.expectedPath,
    allowMissing: true,
  });
  if (
    base.acceptedCommitOid !== mutation.baseCommitOid ||
    base.acceptedTreeOid !== mutation.baseTreeOid
  )
    throw new Error('Candidate base content does not match T1');
  return { authority, epoch, event, dispatchEvent, mutation, call, base, toolOutcome };
}

function finishCandidateSettlement(
  context: Omit<Awaited<ReturnType<typeof verifyDurableMutationContext>>, 'call' | 'base'>,
  candidate: ReturnType<typeof requireGitoxideCandidateOutcomeForAcceptedRepositoryInternal>,
  result: ReturnType<typeof transformManagedMutation>,
  expectedDisposition: 'published' | 'no_change',
): VerifiedCandidateSettlement {
  const { authority, epoch, event, dispatchEvent, mutation, toolOutcome } = context;
  const contentBytes = Buffer.from(result.content, 'utf8');
  const resultBlobOid = createHash('sha1')
    .update(`blob ${contentBytes.length}\0`)
    .update(contentBytes)
    .digest('hex');
  if (
    result.changed !== (expectedDisposition === 'published') ||
    digest(result.content) !== candidate.resultContentSha256 ||
    resultBlobOid !== candidate.resultBlobOid
  )
    throw new Error('Candidate content does not match the durable operation');
  // Match Runtime's durable ToolResultContent representation, not the raw
  // provider object (large-file summaries, for example, are JSON content).
  let expectedContent: unknown;
  try {
    expectedContent = decodeCanonicalToolResultContent(result.providerResult);
  } catch {
    expectedContent = { kind: 'json', value: result.providerResult };
  }
  if (
    event.content?.kind !== 'function_response' ||
    event.content.isError === true ||
    !isDeepStrictEqual(event.content.result, expectedContent)
  )
    throw new Error('Candidate outcome does not match the durable operation result');
  if (expectedDisposition === 'no_change') {
    // The helper retains an operation-bound candidate commit even for no-op;
    // it is the exact tree, not commit metadata, that must preserve the base.
    if (candidate.candidateTreeOid !== candidate.baseTreeOid)
      throw new Error('Unchanged candidate does not preserve the accepted base');
    return {
      kind: 'no_change',
      authority,
      toolOutcome,
      noEffect: {
        operationId: candidate.operationId,
        dispatchEventId: dispatchEvent.id,
        workspaceInstanceId: mutation.workspaceInstanceId,
        terminalKind: 'no_workspace_change',
      },
    };
  }
  const successorId = digest(
    `maka-gitoxide-successor-v1\0${epoch.workspaceEpochId}\0${candidate.operationId}`,
  ).slice(7, 39);
  return {
    kind: 'successor',
    authority,
    toolOutcome,
    successor: {
      acceptedEventId: `workspace-successor-${successorId}`,
      committedAt: toolOutcome.committedAt,
      origin: {
        operationId: candidate.operationId,
        dispatchEventId: dispatchEvent.id,
        outcomeEventId: event.id,
      },
      successor: {
        repositoryId: epoch.repositoryId,
        workspaceId: epoch.workspaceId,
        workspaceEpochId: epoch.workspaceEpochId,
        workspaceVersionId: `version_${successorId}`,
        objectFormat: 'sha1',
        parentWorkspaceVersionId: mutation.baseWorkspaceVersionId,
        baseAcceptedEventId: mutation.baseAcceptedEventId,
        baseHeadRevision: mutation.baseHeadRevision,
        commitOid: candidate.candidateCommitOid,
        treeOid: candidate.candidateTreeOid,
        policyHash: epoch.policyHash,
        treeDeltaDigest: digest(
          `maka-gitoxide-tree-delta-v1\0${candidate.baseTreeOid}\0${candidate.candidateTreeOid}\0${candidate.path}`,
        ),
        changedPaths: [candidate.path],
        changedFileCount: 1,
        deletedFileCount: 0,
        executionProfileDigest: mutation.executionProfileDigest,
      },
    },
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
