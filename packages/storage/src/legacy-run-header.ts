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

/**
 * The Run header as builds before the invocation opening fact wrote it.
 *
 * Nothing writes this shape any more and no live code reads it. It lives here,
 * beside the migration that consumes it, because a persisted row still carries
 * it: reading old data is the only remaining reason the shape exists, and
 * keeping it out of `@maka/core` is what stops it from being a second live
 * authority again.
 */

import {
  decodePersistedPermissionMode,
  isPermissionMode,
  type PermissionMode,
} from '@maka/core/permission';
import { isCollaborationMode, type CollaborationMode } from '@maka/core/collaboration';
import {
  isAgentSwarmAuthorizationSource,
  isEffectiveOrchestrationSource,
  isOrchestrationMode,
  type AgentSwarmAuthorizationSource,
  type EffectiveOrchestrationSource,
  type OrchestrationMode,
} from '@maka/core/orchestration';
import type { PersistedBackendKind } from '@maka/core/session';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from '@maka/core/record-schema';
import { DEFAULT_TOOL_MODE, isToolMode, type ToolMode } from '@maka/core/tool-mode';
import type {
  RuntimeEventInvocationOpenedContent,
  RuntimeInvocationLineage,
  RuntimeInvocationOpenSource,
  RuntimeInvocationRootAuthority,
  RuntimeInvocationRoute,
} from '@maka/core/runtime-event';

const LEGACY_RUN_STATUSES = [
  'created',
  'running',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
] as const;

type LegacyRunStatus = (typeof LEGACY_RUN_STATUSES)[number];

interface LegacyContinuationSourceV1 {
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceRuntimeEventHighWater: number;
}

interface LegacyContinuationSourceV2 extends LegacyContinuationSourceV1 {
  protocol: 'continuation_source_v2';
  claimId: string;
  boundaryDigest: `sha256:${string}`;
  sourcePrefixDigest: `sha256:${string}`;
  replayManifestDigest: `sha256:${string}`;
}

type LegacyContinuationSource = LegacyContinuationSourceV1 | LegacyContinuationSourceV2;

export interface LegacyRunHeader {
  runId: string;
  invocationId?: string;
  sessionId: string;
  turnId: string;
  status: LegacyRunStatus;
  backendKind: PersistedBackendKind;
  llmConnectionId?: string;
  providerStateIdentity?: `sha256:${string}`;
  llmConnectionSlug: string;
  modelId: string;
  cwd: string;
  workspaceIdentity?: string;
  permissionMode: PermissionMode;
  collaborationMode?: CollaborationMode;
  orchestrationMode?: OrchestrationMode;
  orchestrationSource?: EffectiveOrchestrationSource;
  agentSwarmAuthorization?: AgentSwarmAuthorizationSource;
  toolMode?: ToolMode;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  parentRunId?: string;
  resumedFromRunId?: string;
  retriedFromRunId?: string;
  agentId?: string;
  agentName?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  continuationSource?: LegacyContinuationSource;
  scheduledTaskId?: string;
  legacyAutomationId?: string;
  goalId?: string;
  agentGraphWakeId?: string;
  agentGraphWakeAttemptId?: string;
  rootExecutionKind?: 'context_compact';
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
  traceWriteError?: string;
  /**
   * The provider-dispatch snapshot the header era attached to every run that
   * reached a provider. Nothing on the spine reads it back, so the migration
   * only has to know it is there: a header carrying it is a well-formed
   * header, not a corrupt one.
   */
  runComposition?: object;
}

const LEGACY_RUN_HEADER_SHAPE = defineObjectShape<LegacyRunHeader>()(
  [
    'runId',
    'sessionId',
    'turnId',
    'status',
    'backendKind',
    'llmConnectionSlug',
    'modelId',
    'cwd',
    'permissionMode',
    'createdAt',
    'updatedAt',
  ],
  [
    'invocationId',
    'llmConnectionId',
    'providerStateIdentity',
    'completedAt',
    'parentRunId',
    'resumedFromRunId',
    'retriedFromRunId',
    'agentId',
    'agentName',
    'parentTurnId',
    'retriedFromTurnId',
    'regeneratedFromTurnId',
    'branchOfTurnId',
    'parentSessionId',
    'workspaceIdentity',
    'continuationSource',
    'scheduledTaskId',
    'legacyAutomationId',
    'goalId',
    'agentGraphWakeId',
    'agentGraphWakeAttemptId',
    'rootExecutionKind',
    'failureClass',
    'failureMessage',
    'abortSource',
    'traceWriteError',
    'collaborationMode',
    'orchestrationMode',
    'orchestrationSource',
    'agentSwarmAuthorization',
    'toolMode',
    'runComposition',
  ],
);

const LEGACY_CONTINUATION_SOURCE_V1_SHAPE = defineObjectShape<LegacyContinuationSourceV1>()(
  ['sourceInvocationId', 'sourceRunId', 'sourceTurnId', 'sourceRuntimeEventHighWater'],
  [],
);

const LEGACY_CONTINUATION_SOURCE_V2_SHAPE = defineObjectShape<LegacyContinuationSourceV2>()(
  [
    'protocol',
    'sourceInvocationId',
    'sourceRunId',
    'sourceTurnId',
    'sourceRuntimeEventHighWater',
    'claimId',
    'boundaryDigest',
    'sourcePrefixDigest',
    'replayManifestDigest',
  ],
  [],
);

const RETIRED_RUN_STATUSES: Readonly<Record<string, LegacyRunStatus>> = {
  waiting_permission: 'waiting_for_user',
};

export function decodePersistedLegacyRunHeader(persisted: unknown): LegacyRunHeader {
  let value = persisted;
  if (
    isRecord(value) &&
    value.automationId !== undefined &&
    value.legacyAutomationId === undefined
  ) {
    const { automationId, ...current } = value;
    value = { ...current, legacyAutomationId: automationId };
  }
  if (isRecord(value)) {
    const status =
      typeof value.status === 'string'
        ? (RETIRED_RUN_STATUSES[value.status] ?? value.status)
        : value.status;
    const permissionMode = decodePersistedPermissionMode(value.permissionMode);
    if (status !== value.status || permissionMode !== value.permissionMode) {
      value = { ...value, status, permissionMode };
    }
  }
  return decodeLegacyRunHeader(value);
}

function decodeLegacyRunHeader(value: unknown): LegacyRunHeader {
  if (!isRecord(value) || !hasExactShape(value, LEGACY_RUN_HEADER_SHAPE)) {
    throw new Error('Invalid AgentRun header schema');
  }
  const valid =
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    (LEGACY_RUN_STATUSES as readonly unknown[]).includes(value.status) &&
    isPersistedBackendKind(value.backendKind) &&
    (value.llmConnectionId === undefined ||
      (typeof value.llmConnectionId === 'string' && value.llmConnectionId.length > 0)) &&
    (value.providerStateIdentity === undefined || isSha256Digest(value.providerStateIdentity)) &&
    typeof value.llmConnectionSlug === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.cwd === 'string' &&
    isPermissionMode(value.permissionMode) &&
    (value.collaborationMode === undefined || isCollaborationMode(value.collaborationMode)) &&
    (value.orchestrationMode === undefined || isOrchestrationMode(value.orchestrationMode)) &&
    (value.orchestrationSource === undefined ||
      isEffectiveOrchestrationSource(value.orchestrationSource)) &&
    (value.agentSwarmAuthorization === undefined ||
      isAgentSwarmAuthorizationSource(value.agentSwarmAuthorization)) &&
    (value.rootExecutionKind === undefined || value.rootExecutionKind === 'context_compact') &&
    Number(value.scheduledTaskId !== undefined) +
      Number(value.legacyAutomationId !== undefined) +
      Number(value.goalId !== undefined) +
      Number(value.agentGraphWakeId !== undefined) <=
      1 &&
    (value.toolMode === undefined || isToolMode(value.toolMode)) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isOptionalString(value.invocationId) &&
    (value.completedAt === undefined || isFiniteNumber(value.completedAt)) &&
    [
      value.parentRunId,
      value.resumedFromRunId,
      value.retriedFromRunId,
      value.agentId,
      value.agentName,
      value.parentTurnId,
      value.retriedFromTurnId,
      value.regeneratedFromTurnId,
      value.branchOfTurnId,
      value.parentSessionId,
      value.workspaceIdentity,
      value.scheduledTaskId,
      value.legacyAutomationId,
      value.goalId,
      value.agentGraphWakeId,
      value.agentGraphWakeAttemptId,
      value.failureClass,
      value.failureMessage,
      value.abortSource,
      value.traceWriteError,
    ].every(isOptionalString) &&
    (value.runComposition === undefined || isRecord(value.runComposition)) &&
    (value.continuationSource === undefined ||
      isLegacyContinuationSource(value.continuationSource));
  if (!valid) throw new Error('Invalid AgentRun header schema');
  return value as unknown as LegacyRunHeader;
}

/**
 * Project one legacy Run header onto its invocation opening fact.
 *
 * Route provenance fails closed. A header with no Connection identity cannot
 * prove which endpoint and credential owned the run, so it projects as
 * `unknown` rather than as an authenticated route; its transcript and tool
 * evidence stay readable either way.
 *
 * Throws when a root authority marker is present but incomplete — that is
 * corruption, and inventing a root would be worse than refusing one.
 */
export function invocationOpeningFromLegacyRunHeader(
  header: LegacyRunHeader,
): RuntimeEventInvocationOpenedContent {
  const lineage: RuntimeInvocationLineage = {
    ...(header.parentRunId !== undefined ? { parentRunId: header.parentRunId } : {}),
    ...(header.resumedFromRunId !== undefined ? { resumedFromRunId: header.resumedFromRunId } : {}),
    ...(header.retriedFromRunId !== undefined ? { retriedFromRunId: header.retriedFromRunId } : {}),
    ...(header.parentTurnId !== undefined ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.retriedFromTurnId !== undefined
      ? { retriedFromTurnId: header.retriedFromTurnId }
      : {}),
    ...(header.regeneratedFromTurnId !== undefined
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId !== undefined ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.agentId !== undefined ? { agentId: header.agentId } : {}),
    ...(header.agentName !== undefined ? { agentName: header.agentName } : {}),
  };
  return {
    kind: 'invocation_opened',
    protocol: 'invocation_opened_v1',
    route: invocationRouteFromLegacyRunHeader(header),
    configuration: {
      cwd: header.cwd,
      permissionMode: header.permissionMode,
      collaborationMode: header.collaborationMode ?? 'agent',
      orchestrationMode: header.orchestrationMode ?? 'default',
      orchestrationSource: header.orchestrationSource ?? 'session',
      toolMode: header.toolMode ?? DEFAULT_TOOL_MODE,
      ...(header.agentSwarmAuthorization !== undefined
        ? { agentSwarmAuthorization: header.agentSwarmAuthorization }
        : {}),
      ...(header.workspaceIdentity !== undefined
        ? { workspaceIdentity: header.workspaceIdentity }
        : {}),
    },
    root: invocationRootFromLegacyRunHeader(header),
    source: invocationOpenSourceFromLegacyRunHeader(header),
    ...(Object.keys(lineage).length > 0 ? { lineage } : {}),
  };
}

function invocationRouteFromLegacyRunHeader(header: LegacyRunHeader): RuntimeInvocationRoute {
  if (header.llmConnectionId === undefined) {
    return {
      provenance: 'unknown',
      backendKind: header.backendKind,
      llmConnectionSlug: header.llmConnectionSlug,
      modelId: header.modelId,
    };
  }
  return {
    provenance: 'runtime',
    backendKind: header.backendKind,
    llmConnectionId: header.llmConnectionId,
    llmConnectionSlug: header.llmConnectionSlug,
    modelId: header.modelId,
    ...(header.providerStateIdentity !== undefined
      ? { providerStateIdentity: header.providerStateIdentity }
      : {}),
  };
}

function invocationRootFromLegacyRunHeader(
  header: LegacyRunHeader,
): RuntimeInvocationRootAuthority {
  if (header.scheduledTaskId !== undefined) {
    return { kind: 'scheduled_task', scheduledTaskId: header.scheduledTaskId };
  }
  if (header.goalId !== undefined) return { kind: 'goal', goalId: header.goalId };
  if (header.legacyAutomationId !== undefined) {
    return { kind: 'legacy_automation', legacyAutomationId: header.legacyAutomationId };
  }
  if (header.agentGraphWakeId !== undefined) {
    if (header.agentGraphWakeAttemptId === undefined) {
      throw new Error(`AgentRun ${header.runId} has a graph wake with no delivery attempt`);
    }
    return {
      kind: 'agent_graph_supervisor_wake',
      wakeId: header.agentGraphWakeId,
      attemptId: header.agentGraphWakeAttemptId,
    };
  }
  if (header.rootExecutionKind === 'context_compact') return { kind: 'context_compact' };
  return { kind: 'user' };
}

function invocationOpenSourceFromLegacyRunHeader(
  header: LegacyRunHeader,
): RuntimeInvocationOpenSource {
  const source = header.continuationSource;
  if (!source) return { kind: 'fresh' };
  const v2 = 'protocol' in source ? source : undefined;
  return {
    kind: 'continuation',
    sourceInvocationId: source.sourceInvocationId,
    sourceRunId: source.sourceRunId,
    sourceTurnId: source.sourceTurnId,
    sourceRuntimeEventHighWater: source.sourceRuntimeEventHighWater,
    ...(v2 ? { claimId: v2.claimId, boundaryDigest: v2.boundaryDigest } : {}),
  };
}

function isLegacyContinuationSource(value: unknown): value is LegacyContinuationSource {
  if (!isRecord(value)) return false;
  const common =
    typeof value.sourceInvocationId === 'string' &&
    typeof value.sourceRunId === 'string' &&
    typeof value.sourceTurnId === 'string' &&
    typeof value.sourceRuntimeEventHighWater === 'number' &&
    Number.isSafeInteger(value.sourceRuntimeEventHighWater) &&
    value.sourceRuntimeEventHighWater >= 0;
  if (!common) return false;
  if (hasExactShape(value, LEGACY_CONTINUATION_SOURCE_V1_SHAPE)) return true;
  return (
    hasExactShape(value, LEGACY_CONTINUATION_SOURCE_V2_SHAPE) &&
    value.protocol === 'continuation_source_v2' &&
    typeof value.claimId === 'string' &&
    value.claimId.length > 0 &&
    typeof value.sourceInvocationId === 'string' &&
    value.sourceInvocationId.length > 0 &&
    typeof value.sourceRunId === 'string' &&
    value.sourceRunId.length > 0 &&
    typeof value.sourceTurnId === 'string' &&
    value.sourceTurnId.length > 0 &&
    typeof value.sourceRuntimeEventHighWater === 'number' &&
    value.sourceRuntimeEventHighWater > 0 &&
    isSha256Digest(value.boundaryDigest) &&
    isSha256Digest(value.sourcePrefixDigest) &&
    isSha256Digest(value.replayManifestDigest) &&
    value.replayManifestDigest === value.boundaryDigest
  );
}

/** `'fake'` stays accepted: runs written by builds that shipped FakeBackend must keep decoding (#3211). */
function isPersistedBackendKind(value: unknown): value is PersistedBackendKind {
  return value === 'ai-sdk' || value === 'fake';
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
