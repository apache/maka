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
import { scanToolLedger } from '@maka/core/tool-ledger-scanner';
import {
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC,
} from '@maka/core/runtime-event';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { transformManagedMutation } from '@maka/runtime/managed-mutation-transform';
import { encodeDefaultDurableToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import type {
  ExecutionWorkspaceAuthority,
  InteractiveExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  readGitoxideTreeFileInternal,
  requireGitoxideAcceptedIdentityInternal,
  verifyExistingGitoxideCandidateInternal,
  type GitoxideAcceptedRepositoryCapability,
} from './gitoxide-repository-admission-authority-internal.js';
import { verifyGitoxideCandidateSettlementInternal } from './gitoxide-candidate-settlement-internal.js';

export interface GitoxideCandidateRecoveryInput {
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly acceptedRepositoryOwnerToken: object;
  readonly acceptedRepositoryCapability: GitoxideAcceptedRepositoryCapability;
}

/** Recompute pure content from frozen T1; never invoke a tool or create a candidate. */
export async function prepareGitoxideCandidateRecoveryInternal(
  stores: InteractiveExecutionStoresWriter,
  openAuthority: () => Promise<ExecutionWorkspaceAuthority>,
  original: GitoxideCandidateRecoveryInput,
) {
  const input = { ...original };
  if (!input.workspaceKey.trim() || Buffer.byteLength(input.workspaceKey) > 1024)
    throw new Error('Invalid recovery workspace key');
  const identity = requireGitoxideAcceptedIdentityInternal(
    input.acceptedRepositoryOwnerToken,
    input.acceptedRepositoryCapability,
  );
  const authority = await openAuthority();
  const evidence = await stores.runtimeEventStore.readRuntimeEventsBounded(
    input.sessionId,
    input.runId,
    { maxRecords: 16_384, maxBytes: 32 * 1024 * 1024 },
  );
  if (evidence.status !== 'complete') throw new Error('Recovery T1 evidence exceeds read budget');
  const scan = scanToolLedger(evidence.records);
  if (scan.hasCorruption) throw new Error('Recovery tool ledger is corrupt');
  const operation = scan.operations.find((entry) => entry.operationId === input.operationId);
  const dispatchEvent = operation?.dispatchEvent;
  const dispatch = dispatchEvent?.actions?.toolDispatch;
  const mutation = dispatch?.managedMutation;
  const call = operation?.callEvent?.content;
  if (
    !dispatchEvent ||
    !mutation ||
    !call ||
    call.kind !== 'function_call' ||
    (call.name !== 'Write' && call.name !== 'Edit') ||
    dispatch.recoveryMode !== 'reconcile' ||
    mutation.executionProfileDigest !== MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST ||
    operation.reconcileEvents.length ||
    operation.decisionEvents.length
  )
    throw new Error('Recovery requires one managed T1 without recovery decisions');
  const id = hash(`maka-managed-files-workspace-v1\0${input.workspaceKey}`).slice(7, 39);
  const epoch = await authority.readEpoch(`workspace_${id}`, `epoch_${id}`);
  if (
    !epoch ||
    epoch.workspaceInstanceId !== mutation.workspaceInstanceId ||
    epoch.workspaceId !== mutation.workspaceId ||
    epoch.workspaceEpochId !== mutation.workspaceEpochId ||
    epoch.repositoryId !== mutation.repositoryId ||
    epoch.materializationProfileDigest !==
      hash(`maka-gitoxide-import-v3\0${identity.helperArtifactSha256}`) ||
    epoch.policyHash !==
      hash(`maka-managed-files-policy-v3\0${epoch.materializationProfileDigest}`) ||
    epoch.repositoryId !==
      `repository_${hash(`maka-managed-files-repository-v1\0${identity.repositoryPath}`).slice(7, 39)}`
  )
    throw new Error('Recovery workspace identity mismatch');
  const responseId = `${input.operationId}_recovered_response`;
  if (operation.responseEvent) {
    const event = operation.responseEvent;
    if (
      event.id !== responseId ||
      event.content?.kind !== 'function_response' ||
      event.content.isError
    )
      throw new Error('Operation already has a different terminal result');
    const version = await authority.readVersion(
      `version_${hash(`maka-gitoxide-successor-v1\0${epoch.workspaceEpochId}\0${input.operationId}`).slice(7, 39)}`,
    );
    const terminal = event.actions?.managedMutationTerminal;
    if (
      !(
        version?.protocol === 'workspace_version_accepted_v1' &&
        version.origin.operationId === input.operationId &&
        version.origin.dispatchEventId === dispatchEvent.id &&
        version.origin.outcomeEventId === event.id
      ) &&
      !(
        terminal?.terminalKind === 'no_workspace_change' &&
        terminal.operationId === input.operationId &&
        terminal.dispatchEventId === dispatchEvent.id &&
        terminal.workspaceInstanceId === mutation.workspaceInstanceId
      )
    )
      throw new Error('Recovered result has no matching terminal authority');
    const reservation = await authority.readReservation(mutation.workspaceInstanceId);
    if (reservation?.operationId === input.operationId)
      throw new Error('Recovered operation still has a reservation');
    return { kind: 'already_committed' as const, event };
  }
  if (evidence.records.some((event) => event.actions?.endInvocation))
    throw new Error('Cannot settle a mutation after run termination');
  const reservation = await authority.readReservation(mutation.workspaceInstanceId);
  const head = await authority.readHead(epoch.workspaceId, epoch.workspaceEpochId);
  if (
    !reservation ||
    reservation.operationId !== input.operationId ||
    reservation.dispatchEventId !== dispatchEvent.id ||
    !head ||
    head.acceptedEventId !== mutation.baseAcceptedEventId ||
    head.workspaceVersionId !== mutation.baseWorkspaceVersionId ||
    head.revision !== mutation.baseHeadRevision ||
    head.commitOid !== mutation.baseCommitOid ||
    head.treeOid !== mutation.baseTreeOid ||
    identity.baseCommitOid !== mutation.baseCommitOid ||
    identity.baseTreeOid !== mutation.baseTreeOid
  )
    throw new Error('Recovery reservation or accepted base mismatch');
  const base = await readGitoxideTreeFileInternal({
    ...input,
    path: mutation.expectedPath,
    allowMissing: true,
  });
  const result = transformManagedMutation({
    toolName: call.name,
    canonicalPath: mutation.expectedPath,
    baseContent: base.kind === 'tree_file_read' ? base.content : null,
    args: call.args,
  });
  const candidateOwnerToken = {};
  // This value is produced solely by the bounded built-in pure transform,
  // never supplied by the recovering caller or a tool callback.
  if (
    Buffer.byteLength(JSON.stringify(result.providerResult), 'utf8') >
    MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxBytes
  )
    throw new Error('Recovered result exceeds managed profile budget');
  const candidate = await verifyExistingGitoxideCandidateInternal({
    ...input,
    candidateOwnerToken,
    path: mutation.expectedPath,
    content: result.content,
  });
  let content;
  try {
    content = decodeCanonicalToolResultContent(result.providerResult);
  } catch {
    content = { kind: 'json' as const, value: result.providerResult };
  }
  // Logical recovery time, not a claim about the lost process's duration.
  const ts = evidence.records.reduce((max, event) => Math.max(max, event.ts), 0) + 1;
  const event = encodeCanonicalRuntimeEvent({
    id: responseId,
    sessionId: input.sessionId,
    runId: input.runId,
    invocationId: dispatchEvent.invocationId,
    turnId: dispatchEvent.turnId,
    ts,
    partial: false,
    role: 'tool',
    author: 'tool',
    origin: dispatchEvent.origin,
    modelVisibility: dispatchEvent.modelVisibility,
    refs: { ...dispatchEvent.refs },
    content: {
      kind: 'function_response',
      id: call.id,
      name: call.name,
      result: content,
      modelProjection: encodeDefaultDurableToolResultOutput(result.providerResult, input.sessionId),
    },
    ...(!result.changed
      ? {
          actions: {
            managedMutationTerminal: {
              protocol: 'managed_mutation_terminal_v1',
              operationId: input.operationId,
              dispatchEventId: dispatchEvent.id,
              workspaceInstanceId: mutation.workspaceInstanceId,
              terminalKind: 'no_workspace_change',
            },
          },
        }
      : {}),
  }).event;
  const verified = await verifyGitoxideCandidateSettlementInternal(
    stores,
    openAuthority,
    {
      ...input,
      candidateOwnerToken,
      candidateOutcomeCapability: candidate.candidateOutcomeCapability,
      toolOutcome: {
        operationId: input.operationId,
        journalEventId: `${input.operationId}_outcome`,
        runtimeEvent: event,
        committedAt: ts,
      },
    },
    result.changed ? 'published' : 'no_change',
  );
  return { kind: 'pending' as const, event, verified };
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
