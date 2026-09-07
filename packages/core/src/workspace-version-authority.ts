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

import { isCanonicalManagedMutationPathV1, type RuntimeEvent } from './runtime-event.js';

export const WORKSPACE_EPOCH_OPENED_FACT_KIND = 'maka.workspace.epoch_opened' as const;
export const WORKSPACE_BASELINE_ACCEPTED_FACT_KIND = 'maka.workspace.baseline_accepted' as const;
export const WORKSPACE_VERSION_ACCEPTED_FACT_KIND = 'maka.workspace.version_accepted' as const;
export const WORKSPACE_FACT_VERSION = 1 as const;
export const WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1 =
  'runtime_workspace_version_authority_v1' as const;
export const WORKSPACE_AUTHORITY_SESSION_ID = 'maka_workspace_authority' as const;
export const WORKSPACE_MATERIALIZATION_SEMANTICS_V1 =
  'git_tree_materialized_with_fixed_config_v1' as const;

export type WorkspaceGitObjectFormat = 'sha1' | 'sha256';

export interface WorkspaceEpochDescriptorV1 {
  repositoryId: string;
  workspaceId: string;
  workspaceEpochId: string;
  workspaceInstanceId: string;
  mode: 'managed_worktree';
  objectFormat: WorkspaceGitObjectFormat;
  sourceCommitOid: string;
  sourceTreeOid: string;
  materializationProfileDigest: `sha256:${string}`;
  materializationSemantics: typeof WORKSPACE_MATERIALIZATION_SEMANTICS_V1;
  policyHash: `sha256:${string}`;
}

export interface WorkspaceBaselineDescriptorV1 {
  workspaceVersionId: string;
  commitOid: string;
  treeOid: string;
  treeDeltaDigest: `sha256:${string}`;
  changedFileCount: number;
  deletedFileCount: 0;
}

export interface WorkspaceEpochOpenedV1 extends WorkspaceEpochDescriptorV1 {
  protocol: 'workspace_epoch_opened_v1';
  initialWorkspaceVersionId: string;
}

export interface WorkspaceBaselineAcceptedV1 extends WorkspaceBaselineDescriptorV1 {
  protocol: 'workspace_baseline_accepted_v1';
  repositoryId: string;
  workspaceId: string;
  workspaceEpochId: string;
  objectFormat: WorkspaceGitObjectFormat;
  parents: readonly [];
  origin: {
    kind: 'baseline';
    epochOpenedEventId: string;
  };
  policyHash: `sha256:${string}`;
}

export interface WorkspaceSuccessorDescriptorV1 {
  repositoryId: string;
  workspaceId: string;
  workspaceEpochId: string;
  workspaceVersionId: string;
  objectFormat: WorkspaceGitObjectFormat;
  parentWorkspaceVersionId: string;
  baseAcceptedEventId: string;
  baseHeadRevision: number;
  commitOid: string;
  treeOid: string;
  policyHash: `sha256:${string}`;
  treeDeltaDigest: `sha256:${string}`;
  changedPaths: readonly string[];
  changedFileCount: number;
  deletedFileCount: number;
  executionProfileDigest: `sha256:${string}`;
}

export interface WorkspaceMutationOriginV1 {
  operationId: string;
  dispatchEventId: string;
  outcomeEventId: string;
}

export interface WorkspaceVersionAcceptedV1 {
  protocol: 'workspace_version_accepted_v1';
  repositoryId: string;
  workspaceId: string;
  workspaceEpochId: string;
  workspaceVersionId: string;
  objectFormat: WorkspaceGitObjectFormat;
  parents: readonly [string];
  origin: { kind: 'tool_mutation' } & WorkspaceMutationOriginV1;
  baseAcceptedEventId: string;
  baseHeadRevision: number;
  commitOid: string;
  treeOid: string;
  policyHash: `sha256:${string}`;
  treeDeltaDigest: `sha256:${string}`;
  changedPaths: readonly string[];
  changedFileCount: number;
  deletedFileCount: number;
  executionProfileDigest: `sha256:${string}`;
}

export type WorkspaceAcceptedVersionV1 = WorkspaceBaselineAcceptedV1 | WorkspaceVersionAcceptedV1;

export type RuntimeEventWorkspaceFactEnvelope =
  | {
      kind: typeof WORKSPACE_EPOCH_OPENED_FACT_KIND;
      version: typeof WORKSPACE_FACT_VERSION;
      payload: WorkspaceEpochOpenedV1;
    }
  | {
      kind: typeof WORKSPACE_BASELINE_ACCEPTED_FACT_KIND;
      version: typeof WORKSPACE_FACT_VERSION;
      payload: WorkspaceBaselineAcceptedV1;
    }
  | {
      kind: typeof WORKSPACE_VERSION_ACCEPTED_FACT_KIND;
      version: typeof WORKSPACE_FACT_VERSION;
      payload: WorkspaceVersionAcceptedV1;
    };

export interface WorkspaceBaselineAuthorityInput {
  epochOpenedEventId: string;
  baselineAcceptedEventId: string;
  committedAt: number;
  epoch: WorkspaceEpochDescriptorV1;
  baseline: WorkspaceBaselineDescriptorV1;
}

export interface WorkspaceSuccessorAuthorityInput {
  acceptedEventId: string;
  committedAt: number;
  successor: WorkspaceSuccessorDescriptorV1;
  origin: WorkspaceMutationOriginV1;
}

export interface WorkspaceAuthorityIdentity {
  sessionId: typeof WORKSPACE_AUTHORITY_SESSION_ID;
  invocationId: string;
  runId: string;
  turnId: string;
}

export interface WorkspaceBaselineAuthorityEvents {
  epochOpenedEvent: RuntimeEvent;
  baselineAcceptedEvent: RuntimeEvent;
}

export interface WorkspaceAuthorityLedgerRow {
  event: RuntimeEvent;
  eventSeq: number;
}

export interface ScannedWorkspaceBaselineAuthority {
  epoch: WorkspaceEpochOpenedV1;
  baseline: WorkspaceBaselineAcceptedV1;
  epochOpenedEventId: string;
  baselineAcceptedEventId: string;
  epochOpenedAt: number;
  baselineAcceptedAt: number;
  authority: WorkspaceAuthorityIdentity;
}

export interface ScannedWorkspaceSuccessorAuthority {
  successor: WorkspaceVersionAcceptedV1;
  acceptedEventId: string;
  acceptedAt: number;
  eventSeq: number;
  authority: WorkspaceAuthorityIdentity;
}

export interface WorkspaceEpochRecordV1 extends WorkspaceEpochOpenedV1 {
  epochOpenedEventId: string;
  authority: WorkspaceAuthorityIdentity;
  committedAt: number;
}

export type WorkspaceVersionRecordV1 = WorkspaceAcceptedVersionV1 & {
  acceptedEventId: string;
  committedAt: number;
};

export interface WorkspaceHeadRecordV1 {
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceEpochId: string;
  readonly workspaceVersionId: string;
  readonly acceptedEventId: string;
  readonly commitOid: string;
  readonly treeOid: string;
  readonly revision: number;
}

export interface WorkspaceBaselineCommitResult {
  created: boolean;
  head: WorkspaceHeadRecordV1;
}

export interface WorkspaceProjectionRebuildResult {
  epochs: number;
  versions: number;
  heads: number;
}

export type WorkspaceAuthorityIssueCode =
  | 'semantic_lane_conflict'
  | 'authority_stream_contamination'
  | 'duplicate_event_id'
  | 'duplicate_epoch_opened'
  | 'duplicate_baseline_version'
  | 'duplicate_workspace_version'
  | 'missing_baseline_version'
  | 'orphan_baseline_version'
  | 'event_order_conflict'
  | 'baseline_contract_conflict'
  | 'successor_contract_conflict'
  | 'workspace_head_conflict';

export interface WorkspaceAuthorityIssue {
  code: WorkspaceAuthorityIssueCode;
  eventId: string;
  workspaceEpochId?: string;
}

export interface WorkspaceBaselineAuthorityScanResult {
  baselines: ScannedWorkspaceBaselineAuthority[];
  successors: ScannedWorkspaceSuccessorAuthority[];
  heads: WorkspaceHeadRecordV1[];
  issues: WorkspaceAuthorityIssue[];
  hasCorruption: boolean;
}

export type WorkspaceFactEventLaneValidation =
  | { ok: true }
  | { ok: false; code: 'semantic_lane_conflict'; eventId: string };

const IDENTIFIER_PATTERNS = {
  repositoryId: /^repository_[a-f0-9]{32}$/u,
  workspaceId: /^workspace_[a-f0-9]{32}$/u,
  workspaceEpochId: /^epoch_[a-f0-9]{32}$/u,
  workspaceInstanceId: /^instance_[a-f0-9]{32}$/u,
  workspaceVersionId: /^version_[a-f0-9]{32}$/u,
} as const;
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function workspaceAuthorityIdentity(workspaceEpochId: string): WorkspaceAuthorityIdentity {
  if (!IDENTIFIER_PATTERNS.workspaceEpochId.test(workspaceEpochId)) {
    throw new Error(`Invalid workspace epoch id: ${workspaceEpochId}`);
  }
  const suffix = workspaceEpochId.slice('epoch_'.length);
  return {
    sessionId: WORKSPACE_AUTHORITY_SESSION_ID,
    invocationId: `workspace_inv_${suffix}`,
    runId: `workspace_run_${suffix}`,
    turnId: `workspace_turn_${suffix}`,
  };
}

export function buildWorkspaceBaselineAuthorityEvents(
  input: WorkspaceBaselineAuthorityInput,
): WorkspaceBaselineAuthorityEvents {
  assertWorkspaceBaselineAuthorityInput(input);
  const identity = workspaceAuthorityIdentity(input.epoch.workspaceEpochId);
  const epochPayload: WorkspaceEpochOpenedV1 = {
    protocol: 'workspace_epoch_opened_v1',
    ...input.epoch,
    initialWorkspaceVersionId: input.baseline.workspaceVersionId,
  };
  const baselinePayload: WorkspaceBaselineAcceptedV1 = {
    protocol: 'workspace_baseline_accepted_v1',
    repositoryId: input.epoch.repositoryId,
    workspaceId: input.epoch.workspaceId,
    workspaceEpochId: input.epoch.workspaceEpochId,
    workspaceVersionId: input.baseline.workspaceVersionId,
    objectFormat: input.epoch.objectFormat,
    parents: [],
    origin: { kind: 'baseline', epochOpenedEventId: input.epochOpenedEventId },
    commitOid: input.baseline.commitOid,
    treeOid: input.baseline.treeOid,
    policyHash: input.epoch.policyHash,
    treeDeltaDigest: input.baseline.treeDeltaDigest,
    changedFileCount: input.baseline.changedFileCount,
    deletedFileCount: input.baseline.deletedFileCount,
  };
  const epochOpenedEvent: RuntimeEvent = {
    id: input.epochOpenedEventId,
    ...identity,
    ts: input.committedAt,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      workspaceFact: {
        kind: WORKSPACE_EPOCH_OPENED_FACT_KIND,
        version: WORKSPACE_FACT_VERSION,
        payload: epochPayload,
      },
    },
  };
  const baselineAcceptedEvent: RuntimeEvent = {
    id: input.baselineAcceptedEventId,
    ...identity,
    ts: input.committedAt,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      workspaceFact: {
        kind: WORKSPACE_BASELINE_ACCEPTED_FACT_KIND,
        version: WORKSPACE_FACT_VERSION,
        payload: baselinePayload,
      },
    },
  };
  assertWorkspaceBaselineAuthorityPair({
    epochOpenedEvent,
    baselineAcceptedEvent,
    epochEventSeq: 1,
    baselineEventSeq: 2,
  });
  return { epochOpenedEvent, baselineAcceptedEvent };
}

export function buildWorkspaceSuccessorAuthorityEvent(
  input: WorkspaceSuccessorAuthorityInput,
): RuntimeEvent {
  assertWorkspaceSuccessorAuthorityInput(input);
  const identity = workspaceAuthorityIdentity(input.successor.workspaceEpochId);
  const payload: WorkspaceVersionAcceptedV1 = {
    protocol: 'workspace_version_accepted_v1',
    repositoryId: input.successor.repositoryId,
    workspaceId: input.successor.workspaceId,
    workspaceEpochId: input.successor.workspaceEpochId,
    workspaceVersionId: input.successor.workspaceVersionId,
    objectFormat: input.successor.objectFormat,
    parents: [input.successor.parentWorkspaceVersionId],
    origin: { kind: 'tool_mutation', ...input.origin },
    baseAcceptedEventId: input.successor.baseAcceptedEventId,
    baseHeadRevision: input.successor.baseHeadRevision,
    commitOid: input.successor.commitOid,
    treeOid: input.successor.treeOid,
    policyHash: input.successor.policyHash,
    treeDeltaDigest: input.successor.treeDeltaDigest,
    changedPaths: input.successor.changedPaths,
    changedFileCount: input.successor.changedFileCount,
    deletedFileCount: input.successor.deletedFileCount,
    executionProfileDigest: input.successor.executionProfileDigest,
  };
  return {
    id: input.acceptedEventId,
    ...identity,
    ts: input.committedAt,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      workspaceFact: {
        kind: WORKSPACE_VERSION_ACCEPTED_FACT_KIND,
        version: WORKSPACE_FACT_VERSION,
        payload,
      },
    },
  };
}

export function isRuntimeEventWorkspaceFactEnvelope(
  value: unknown,
): value is RuntimeEventWorkspaceFactEnvelope {
  if (!hasExactKeys(value, ['kind', 'version', 'payload']) || value.version !== 1) return false;
  if (value.kind === WORKSPACE_EPOCH_OPENED_FACT_KIND) {
    return isWorkspaceEpochOpenedV1(value.payload);
  }
  if (value.kind === WORKSPACE_BASELINE_ACCEPTED_FACT_KIND) {
    return isWorkspaceBaselineAcceptedV1(value.payload);
  }
  if (value.kind === WORKSPACE_VERSION_ACCEPTED_FACT_KIND) {
    return isWorkspaceVersionAcceptedV1(value.payload);
  }
  return false;
}

export function validateWorkspaceFactEventLane(
  event: RuntimeEvent,
): WorkspaceFactEventLaneValidation {
  const fact = event.actions?.workspaceFact;
  const actionKeys = event.actions ? Object.keys(event.actions) : [];
  if (!fact) return { ok: false, code: 'semantic_lane_conflict', eventId: event.id };
  let identity: WorkspaceAuthorityIdentity;
  try {
    identity = workspaceAuthorityIdentity(fact.payload.workspaceEpochId);
  } catch {
    return { ok: false, code: 'semantic_lane_conflict', eventId: event.id };
  }
  if (
    event.sessionId !== identity.sessionId ||
    event.invocationId !== identity.invocationId ||
    event.runId !== identity.runId ||
    event.turnId !== identity.turnId ||
    event.partial ||
    event.role !== 'system' ||
    event.author !== 'system' ||
    event.branch !== undefined ||
    event.status !== undefined ||
    event.content !== undefined ||
    event.refs !== undefined ||
    actionKeys.length !== 1 ||
    actionKeys[0] !== 'workspaceFact'
  ) {
    return { ok: false, code: 'semantic_lane_conflict', eventId: event.id };
  }
  return { ok: true };
}

export function scanWorkspaceBaselineAuthority(
  rows: readonly WorkspaceAuthorityLedgerRow[],
): WorkspaceBaselineAuthorityScanResult {
  const issues: WorkspaceAuthorityIssue[] = [];
  const seenEventIds = new Set<string>();
  const epochRows = new Map<string, WorkspaceAuthorityLedgerRow[]>();
  const baselineRows = new Map<string, WorkspaceAuthorityLedgerRow[]>();
  const successorRows = new Map<string, WorkspaceAuthorityLedgerRow[]>();
  const versionIds = new Map<string, string>();

  for (const row of rows) {
    const { event } = row;
    const fact = event.actions?.workspaceFact;
    const touchesAuthority =
      fact !== undefined || event.sessionId === WORKSPACE_AUTHORITY_SESSION_ID;
    if (!touchesAuthority) continue;
    if (seenEventIds.has(event.id)) {
      issues.push({ code: 'duplicate_event_id', eventId: event.id });
      continue;
    }
    seenEventIds.add(event.id);
    if (!fact) {
      issues.push({ code: 'authority_stream_contamination', eventId: event.id });
      continue;
    }
    const lane = validateWorkspaceFactEventLane(event);
    if (!lane.ok) {
      issues.push(lane);
      continue;
    }
    const epochId = fact.payload.workspaceEpochId;
    if (fact.kind === WORKSPACE_EPOCH_OPENED_FACT_KIND) {
      const matches = epochRows.get(epochId) ?? [];
      matches.push(row);
      epochRows.set(epochId, matches);
      continue;
    }
    const target =
      fact.kind === WORKSPACE_BASELINE_ACCEPTED_FACT_KIND ? baselineRows : successorRows;
    const matches = target.get(epochId) ?? [];
    matches.push(row);
    target.set(epochId, matches);
    const priorEpoch = versionIds.get(fact.payload.workspaceVersionId);
    if (priorEpoch !== undefined) {
      issues.push({
        code: 'duplicate_workspace_version',
        eventId: event.id,
        workspaceEpochId: epochId,
      });
    } else {
      versionIds.set(fact.payload.workspaceVersionId, epochId);
    }
  }

  const baselines: ScannedWorkspaceBaselineAuthority[] = [];
  const successors: ScannedWorkspaceSuccessorAuthority[] = [];
  const heads: WorkspaceHeadRecordV1[] = [];
  const epochIds = new Set([...epochRows.keys(), ...baselineRows.keys(), ...successorRows.keys()]);
  for (const epochId of [...epochIds].sort()) {
    const opened = epochRows.get(epochId) ?? [];
    const accepted = baselineRows.get(epochId) ?? [];
    const pendingSuccessors = [...(successorRows.get(epochId) ?? [])].sort(
      (left, right) =>
        left.eventSeq - right.eventSeq || left.event.id.localeCompare(right.event.id),
    );
    if (opened.length === 0) {
      issues.push({
        code: 'orphan_baseline_version',
        eventId: (accepted[0] ?? pendingSuccessors[0])!.event.id,
        workspaceEpochId: epochId,
      });
      continue;
    }
    if (opened.length > 1) {
      issues.push({
        code: 'duplicate_epoch_opened',
        eventId: opened[1]!.event.id,
        workspaceEpochId: epochId,
      });
      continue;
    }
    if (accepted.length === 0) {
      issues.push({
        code: 'missing_baseline_version',
        eventId: opened[0]!.event.id,
        workspaceEpochId: epochId,
      });
      continue;
    }
    if (accepted.length > 1) {
      issues.push({
        code: 'duplicate_baseline_version',
        eventId: accepted[1]!.event.id,
        workspaceEpochId: epochId,
      });
      continue;
    }
    let baseline: ScannedWorkspaceBaselineAuthority;
    try {
      baseline = assertWorkspaceBaselineAuthorityPair({
        epochOpenedEvent: opened[0]!.event,
        baselineAcceptedEvent: accepted[0]!.event,
        epochEventSeq: opened[0]!.eventSeq,
        baselineEventSeq: accepted[0]!.eventSeq,
      });
      baselines.push(baseline);
    } catch (error) {
      const code =
        error instanceof WorkspaceAuthorityContractError
          ? error.code
          : ('baseline_contract_conflict' as const);
      issues.push({
        code,
        eventId: accepted[0]!.event.id,
        workspaceEpochId: epochId,
      });
      continue;
    }

    let head: WorkspaceHeadRecordV1 = {
      repositoryId: baseline.epoch.repositoryId,
      workspaceId: baseline.epoch.workspaceId,
      workspaceEpochId: baseline.epoch.workspaceEpochId,
      workspaceVersionId: baseline.baseline.workspaceVersionId,
      acceptedEventId: baseline.baselineAcceptedEventId,
      commitOid: baseline.baseline.commitOid,
      treeOid: baseline.baseline.treeOid,
      revision: 1,
    };
    for (const row of pendingSuccessors) {
      try {
        const scanned = assertWorkspaceSuccessorAuthority({
          baseline,
          currentHead: head,
          event: row.event,
          eventSeq: row.eventSeq,
        });
        successors.push(scanned);
        head = {
          repositoryId: scanned.successor.repositoryId,
          workspaceId: scanned.successor.workspaceId,
          workspaceEpochId: scanned.successor.workspaceEpochId,
          workspaceVersionId: scanned.successor.workspaceVersionId,
          acceptedEventId: scanned.acceptedEventId,
          commitOid: scanned.successor.commitOid,
          treeOid: scanned.successor.treeOid,
          revision: head.revision + 1,
        };
      } catch (error) {
        issues.push({
          code:
            error instanceof WorkspaceAuthorityContractError
              ? error.code
              : 'successor_contract_conflict',
          eventId: row.event.id,
          workspaceEpochId: epochId,
        });
        break;
      }
    }
    heads.push(head);
  }

  return {
    baselines: issues.length === 0 ? baselines : [],
    successors: issues.length === 0 ? successors : [],
    heads: issues.length === 0 ? heads : [],
    issues,
    hasCorruption: issues.length > 0,
  };
}

class WorkspaceAuthorityContractError extends Error {
  constructor(
    readonly code: Extract<
      WorkspaceAuthorityIssueCode,
      | 'event_order_conflict'
      | 'baseline_contract_conflict'
      | 'successor_contract_conflict'
      | 'workspace_head_conflict'
    >,
    message: string,
  ) {
    super(message);
  }
}

function assertWorkspaceBaselineAuthorityPair(input: {
  epochOpenedEvent: RuntimeEvent;
  baselineAcceptedEvent: RuntimeEvent;
  epochEventSeq: number;
  baselineEventSeq: number;
}): ScannedWorkspaceBaselineAuthority {
  const epochLane = validateWorkspaceFactEventLane(input.epochOpenedEvent);
  const baselineLane = validateWorkspaceFactEventLane(input.baselineAcceptedEvent);
  const epochFact = input.epochOpenedEvent.actions?.workspaceFact;
  const baselineFact = input.baselineAcceptedEvent.actions?.workspaceFact;
  if (
    !epochLane.ok ||
    !baselineLane.ok ||
    epochFact?.kind !== WORKSPACE_EPOCH_OPENED_FACT_KIND ||
    baselineFact?.kind !== WORKSPACE_BASELINE_ACCEPTED_FACT_KIND
  ) {
    throw new WorkspaceAuthorityContractError(
      'baseline_contract_conflict',
      'Invalid workspace baseline authority event lanes',
    );
  }
  const epoch = epochFact.payload;
  const baseline = baselineFact.payload;
  if (input.epochEventSeq !== 1 || input.baselineEventSeq !== 2) {
    throw new WorkspaceAuthorityContractError(
      'event_order_conflict',
      'Workspace baseline authority events must be sequence one and two',
    );
  }
  if (
    input.epochOpenedEvent.sessionId !== input.baselineAcceptedEvent.sessionId ||
    input.epochOpenedEvent.invocationId !== input.baselineAcceptedEvent.invocationId ||
    input.epochOpenedEvent.runId !== input.baselineAcceptedEvent.runId ||
    input.epochOpenedEvent.turnId !== input.baselineAcceptedEvent.turnId ||
    input.epochOpenedEvent.ts !== input.baselineAcceptedEvent.ts ||
    epoch.repositoryId !== baseline.repositoryId ||
    epoch.workspaceId !== baseline.workspaceId ||
    epoch.workspaceEpochId !== baseline.workspaceEpochId ||
    epoch.objectFormat !== baseline.objectFormat ||
    epoch.policyHash !== baseline.policyHash ||
    epoch.initialWorkspaceVersionId !== baseline.workspaceVersionId ||
    baseline.origin.epochOpenedEventId !== input.epochOpenedEvent.id ||
    baseline.parents.length !== 0 ||
    epoch.sourceTreeOid !== baseline.treeOid
  ) {
    throw new WorkspaceAuthorityContractError(
      'baseline_contract_conflict',
      'Workspace baseline facts do not describe one causal boundary',
    );
  }
  return {
    epoch,
    baseline,
    epochOpenedEventId: input.epochOpenedEvent.id,
    baselineAcceptedEventId: input.baselineAcceptedEvent.id,
    epochOpenedAt: input.epochOpenedEvent.ts,
    baselineAcceptedAt: input.baselineAcceptedEvent.ts,
    authority: workspaceAuthorityIdentity(epoch.workspaceEpochId),
  };
}

function assertWorkspaceSuccessorAuthority(input: {
  baseline: ScannedWorkspaceBaselineAuthority;
  currentHead: WorkspaceHeadRecordV1;
  event: RuntimeEvent;
  eventSeq: number;
}): ScannedWorkspaceSuccessorAuthority {
  const lane = validateWorkspaceFactEventLane(input.event);
  const fact = input.event.actions?.workspaceFact;
  if (!lane.ok || fact?.kind !== WORKSPACE_VERSION_ACCEPTED_FACT_KIND) {
    throw new WorkspaceAuthorityContractError(
      'successor_contract_conflict',
      'Invalid workspace successor authority event lane',
    );
  }
  const successor = fact.payload;
  const expectedSeq = input.currentHead.revision + 2;
  if (input.eventSeq !== expectedSeq) {
    throw new WorkspaceAuthorityContractError(
      'event_order_conflict',
      'Workspace successor facts must form one contiguous authority sequence',
    );
  }
  if (
    successor.repositoryId !== input.baseline.epoch.repositoryId ||
    successor.workspaceId !== input.baseline.epoch.workspaceId ||
    successor.workspaceEpochId !== input.baseline.epoch.workspaceEpochId ||
    successor.objectFormat !== input.baseline.epoch.objectFormat ||
    successor.policyHash !== input.baseline.epoch.policyHash ||
    successor.parents[0] !== input.currentHead.workspaceVersionId ||
    successor.baseAcceptedEventId !== input.currentHead.acceptedEventId ||
    successor.baseHeadRevision !== input.currentHead.revision
  ) {
    throw new WorkspaceAuthorityContractError(
      'workspace_head_conflict',
      'Workspace successor does not advance the current canonical head',
    );
  }
  return {
    successor,
    acceptedEventId: input.event.id,
    acceptedAt: input.event.ts,
    eventSeq: input.eventSeq,
    authority: workspaceAuthorityIdentity(successor.workspaceEpochId),
  };
}

function assertWorkspaceBaselineAuthorityInput(input: WorkspaceBaselineAuthorityInput): void {
  if (
    !EVENT_ID_PATTERN.test(input.epochOpenedEventId) ||
    !EVENT_ID_PATTERN.test(input.baselineAcceptedEventId) ||
    input.epochOpenedEventId === input.baselineAcceptedEventId ||
    !Number.isSafeInteger(input.committedAt) ||
    input.committedAt < 0 ||
    !isWorkspaceEpochDescriptor(input.epoch) ||
    !isWorkspaceBaselineDescriptor(input.baseline, input.epoch.objectFormat) ||
    input.baseline.treeOid !== input.epoch.sourceTreeOid
  ) {
    throw new Error('Invalid workspace baseline authority input');
  }
}

function assertWorkspaceSuccessorAuthorityInput(input: WorkspaceSuccessorAuthorityInput): void {
  if (
    !EVENT_ID_PATTERN.test(input.acceptedEventId) ||
    !Number.isSafeInteger(input.committedAt) ||
    input.committedAt < 0 ||
    !isWorkspaceSuccessorDescriptor(input.successor) ||
    !isWorkspaceMutationOrigin(input.origin)
  ) {
    throw new Error('Invalid workspace successor authority input');
  }
}

function isWorkspaceEpochOpenedV1(value: unknown): value is WorkspaceEpochOpenedV1 {
  return (
    hasExactKeys(value, [
      'protocol',
      'repositoryId',
      'workspaceId',
      'workspaceEpochId',
      'workspaceInstanceId',
      'initialWorkspaceVersionId',
      'mode',
      'objectFormat',
      'sourceCommitOid',
      'sourceTreeOid',
      'materializationProfileDigest',
      'materializationSemantics',
      'policyHash',
    ]) &&
    value.protocol === 'workspace_epoch_opened_v1' &&
    isWorkspaceEpochDescriptor(value) &&
    isIdentifier(value.initialWorkspaceVersionId, 'workspaceVersionId')
  );
}

function isWorkspaceEpochDescriptor(value: unknown): value is WorkspaceEpochDescriptorV1 {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.repositoryId, 'repositoryId') &&
    isIdentifier(value.workspaceId, 'workspaceId') &&
    isIdentifier(value.workspaceEpochId, 'workspaceEpochId') &&
    isIdentifier(value.workspaceInstanceId, 'workspaceInstanceId') &&
    value.mode === 'managed_worktree' &&
    isObjectFormat(value.objectFormat) &&
    isGitOid(value.sourceCommitOid, value.objectFormat) &&
    isGitOid(value.sourceTreeOid, value.objectFormat) &&
    isSha256Digest(value.materializationProfileDigest) &&
    value.materializationSemantics === WORKSPACE_MATERIALIZATION_SEMANTICS_V1 &&
    isSha256Digest(value.policyHash)
  );
}

function isWorkspaceBaselineAcceptedV1(value: unknown): value is WorkspaceBaselineAcceptedV1 {
  if (
    !hasExactKeys(value, [
      'protocol',
      'repositoryId',
      'workspaceId',
      'workspaceEpochId',
      'workspaceVersionId',
      'objectFormat',
      'parents',
      'origin',
      'commitOid',
      'treeOid',
      'policyHash',
      'treeDeltaDigest',
      'changedFileCount',
      'deletedFileCount',
    ]) ||
    value.protocol !== 'workspace_baseline_accepted_v1' ||
    !isIdentifier(value.repositoryId, 'repositoryId') ||
    !isIdentifier(value.workspaceId, 'workspaceId') ||
    !isIdentifier(value.workspaceEpochId, 'workspaceEpochId') ||
    !isIdentifier(value.workspaceVersionId, 'workspaceVersionId') ||
    !isObjectFormat(value.objectFormat) ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 0 ||
    !hasExactKeys(value.origin, ['kind', 'epochOpenedEventId']) ||
    value.origin.kind !== 'baseline' ||
    !EVENT_ID_PATTERN.test(String(value.origin.epochOpenedEventId)) ||
    !isSha256Digest(value.policyHash)
  ) {
    return false;
  }
  return isWorkspaceBaselineDescriptor(value, value.objectFormat);
}

function isWorkspaceVersionAcceptedV1(value: unknown): value is WorkspaceVersionAcceptedV1 {
  if (
    !hasExactKeys(value, [
      'protocol',
      'repositoryId',
      'workspaceId',
      'workspaceEpochId',
      'workspaceVersionId',
      'objectFormat',
      'parents',
      'origin',
      'baseAcceptedEventId',
      'baseHeadRevision',
      'commitOid',
      'treeOid',
      'policyHash',
      'treeDeltaDigest',
      'changedPaths',
      'changedFileCount',
      'deletedFileCount',
      'executionProfileDigest',
    ]) ||
    value.protocol !== 'workspace_version_accepted_v1' ||
    !isWorkspaceSuccessorDescriptor({
      ...value,
      parentWorkspaceVersionId: Array.isArray(value.parents) ? value.parents[0] : undefined,
    }) ||
    !Array.isArray(value.parents) ||
    value.parents.length !== 1 ||
    !hasExactKeys(value.origin, ['kind', 'operationId', 'dispatchEventId', 'outcomeEventId']) ||
    value.origin.kind !== 'tool_mutation' ||
    !isWorkspaceMutationOrigin(value.origin)
  ) {
    return false;
  }
  return true;
}

function isWorkspaceSuccessorDescriptor(value: unknown): value is WorkspaceSuccessorDescriptorV1 {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.repositoryId, 'repositoryId') &&
    isIdentifier(value.workspaceId, 'workspaceId') &&
    isIdentifier(value.workspaceEpochId, 'workspaceEpochId') &&
    isIdentifier(value.workspaceVersionId, 'workspaceVersionId') &&
    isIdentifier(value.parentWorkspaceVersionId, 'workspaceVersionId') &&
    EVENT_ID_PATTERN.test(String(value.baseAcceptedEventId)) &&
    value.workspaceVersionId !== value.parentWorkspaceVersionId &&
    isObjectFormat(value.objectFormat) &&
    Number.isSafeInteger(value.baseHeadRevision) &&
    Number(value.baseHeadRevision) > 0 &&
    isGitOid(value.commitOid, value.objectFormat) &&
    isGitOid(value.treeOid, value.objectFormat) &&
    isSha256Digest(value.policyHash) &&
    isSha256Digest(value.treeDeltaDigest) &&
    isCanonicalManagedMutationPathSet(value.changedPaths) &&
    isNonNegativeSafeInteger(value.changedFileCount) &&
    value.changedFileCount === value.changedPaths.length &&
    isNonNegativeSafeInteger(value.deletedFileCount) &&
    isSha256Digest(value.executionProfileDigest)
  );
}

function isCanonicalManagedMutationPathSet(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  if (!value.every(isCanonicalManagedMutationPathV1)) return false;
  return value.every((path, index) => index === 0 || value[index - 1]! < path);
}

function isWorkspaceMutationOrigin(value: unknown): value is WorkspaceMutationOriginV1 {
  if (!isRecord(value)) return false;
  return (
    EVENT_ID_PATTERN.test(String(value.operationId)) &&
    EVENT_ID_PATTERN.test(String(value.dispatchEventId)) &&
    EVENT_ID_PATTERN.test(String(value.outcomeEventId)) &&
    value.dispatchEventId !== value.outcomeEventId
  );
}

function isWorkspaceBaselineDescriptor(
  value: unknown,
  objectFormat: WorkspaceGitObjectFormat,
): value is WorkspaceBaselineDescriptorV1 {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.workspaceVersionId, 'workspaceVersionId') &&
    isGitOid(value.commitOid, objectFormat) &&
    isGitOid(value.treeOid, objectFormat) &&
    isSha256Digest(value.treeDeltaDigest) &&
    isNonNegativeSafeInteger(value.changedFileCount) &&
    value.deletedFileCount === 0
  );
}

function isIdentifier(value: unknown, kind: keyof typeof IDENTIFIER_PATTERNS): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERNS[kind].test(value);
}

function isObjectFormat(value: unknown): value is WorkspaceGitObjectFormat {
  return value === 'sha1' || value === 'sha256';
}

function isGitOid(value: unknown, format: WorkspaceGitObjectFormat): value is string {
  return (
    typeof value === 'string' &&
    (format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u).test(value)
  );
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
