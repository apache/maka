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

import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  EmittedAgentRunEvent,
} from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { StorageRef, ToolResultContent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { isEmittedAgentRunEventType, isSessionInlineRun } from '@maka/core/agent-run';
import { TOOL_RECOVERY_DECISION_FACT_KIND } from '@maka/core/tool-recovery-fact';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from './history-compact-checkpoint.js';
import { findCheckpointSummaryDefect } from './history-compact-summary-validation.js';
import { isHistoryCompactContentEvent } from './history-compact.js';
import {
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from './terminal-run-commit.js';
import { buildToolOperationId } from './runtime-commit-sink.js';
import { isContinuationStartRuntimeEvent } from './runtime-event-read-model.js';
import {
  buildToolResultArchiveResourceRef,
  parseToolResultArchiveResourceRef,
} from './tool-result-archive-resource.js';
import {
  deserializeToolResultArchive,
  isArchivedToolResultPlaceholder,
  type ArchivedToolResultPlaceholder,
} from './tool-result-archive.js';

export interface ConversationCopySlice {
  readonly messages: readonly StoredMessage[];
  readonly turnIds: readonly string[];
  readonly beforeTs?: number;
}

interface ConversationCopyIdentityMap {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
}

export interface ConversationCopyExternalChildReferences {
  readonly runIds: ReadonlySet<string>;
  readonly artifactIds: ReadonlySet<string>;
}

export interface ConversationCopyLinkedChildReference {
  readonly childSessionId: string;
  readonly runId?: string;
  readonly resumedFromRunId?: string;
  readonly turnId?: string;
  readonly artifactIds: readonly string[];
  readonly status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user';
  readonly failureClass?: string;
}

export type ConversationCopyArtifactReferenceMap =
  | (ConversationCopyIdentityMap & {
      readonly mode: 'exact';
      readonly artifactIds: ReadonlyMap<string, string>;
      readonly relativePaths: ReadonlyMap<string, string>;
      readonly linkedChildren:
        | { readonly mode: 'reject' }
        | {
            readonly mode: 'preserve_validated';
            readonly references: ReadonlyMap<string, ConversationCopyExternalChildReferences>;
          };
    })
  | (ConversationCopyIdentityMap & {
      readonly mode: 'preserve_external';
    });

export type ConversationCopyMessageReferenceMap = ConversationCopyArtifactReferenceMap & {
  readonly runIds: ReadonlyMap<string, string>;
  readonly runtimeEventIds: ReadonlyMap<string, string>;
  readonly providerTraceIds: ReadonlyMap<string, string>;
};

export type ConversationCopyReferenceMap = ConversationCopyMessageReferenceMap & {
  readonly invocationIds: ReadonlyMap<string, string>;
  readonly operationIds: ReadonlyMap<string, string>;
  readonly agentRunEventIds: ReadonlyMap<string, string>;
};

export interface CloneConversationRuntimeLedgerInput {
  readonly plan: ConversationRuntimeLedgerCopyPlan;
  readonly copiedMessages: readonly StoredMessage[];
  readonly referenceMap: ConversationCopyArtifactReferenceMap;
  readonly runStore: AgentRunStore;
  readonly runtimeEventStore: RuntimeEventStore & {
    importConversationCopyRuntimeEvents?(
      sessionId: string,
      batches: readonly {
        readonly runId: string;
        readonly events: readonly RuntimeEvent[];
      }[],
    ): Promise<void>;
  };
  readonly newId: () => string;
}

export interface ConversationRuntimeLedgerCopyPlan {
  readonly sourceSessionId: string;
  readonly copyTurnIds: readonly string[];
  readonly inlineRuntimeEvents: readonly RuntimeEvent[];
  readonly runs: readonly {
    readonly run: AgentRunHeader;
    readonly runtimeEvents: readonly RuntimeEvent[];
    readonly operationalEvents: readonly AgentRunEvent[];
  }[];
}

export interface CloneConversationRuntimeLedgerResult {
  readonly copiedMessages: readonly StoredMessage[];
  readonly runIdMap: readonly {
    readonly sourceRunId: string;
    readonly targetRunId: string;
  }[];
}

export function createConversationCopySlice(
  messages: readonly StoredMessage[],
  sourceTurnId: string,
  boundary: 'through' | 'before',
): ConversationCopySlice | null {
  const turnOrder: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const turnId = messageTurnId(message);
    if (turnId && !seen.has(turnId)) {
      seen.add(turnId);
      turnOrder.push(turnId);
    }
  }
  const sourceIndex = turnOrder.indexOf(sourceTurnId);
  if (sourceIndex < 0) return null;
  const retainedTurnIds =
    boundary === 'through' ? turnOrder.slice(0, sourceIndex + 1) : turnOrder.slice(0, sourceIndex);
  const retained = new Set(retainedTurnIds);
  const firstExcludedTurnId =
    boundary === 'through' ? turnOrder[sourceIndex + 1] : turnOrder[sourceIndex];
  const firstExcludedTimestamps =
    firstExcludedTurnId === undefined
      ? []
      : messages
          .filter((message) => messageTurnId(message) === firstExcludedTurnId)
          .map((message) => message.ts);
  return {
    messages: messages.filter((message) => {
      if (message.type === 'turn_state') return false;
      const turnId = messageTurnId(message);
      return turnId !== undefined && retained.has(turnId);
    }),
    turnIds: retainedTurnIds,
    ...(firstExcludedTimestamps.length > 0
      ? { beforeTs: Math.min(...firstExcludedTimestamps) }
      : {}),
  };
}

export function rewriteConversationCopyMessage(
  message: StoredMessage,
  references: ConversationCopyMessageReferenceMap,
): StoredMessage {
  if (message.type === 'user' && message.attachments) {
    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        ref: rewriteStorageRef(attachment.ref, references),
      })),
    };
  }
  if (message.type === 'tool_result') {
    return {
      ...message,
      content: rewriteToolResultContent(message.content, references),
    };
  }
  if (message.type === 'token_usage' && message.providerRequestTraceId) {
    return {
      ...message,
      providerRequestTraceId: rewriteOwnedId(
        message.providerRequestTraceId,
        references.providerTraceIds,
        'provider trace',
      ),
    };
  }
  return message;
}

export async function prepareConversationRuntimeLedgerCopy(input: {
  readonly sourceSessionId: string;
  readonly sourceEvents: readonly RuntimeEvent[];
  readonly copiedMessages: readonly StoredMessage[];
  readonly runStore: Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'>;
  readonly runtimeEventStore: Pick<RuntimeEventStore, 'readRuntimeEvents'>;
}): Promise<ConversationRuntimeLedgerCopyPlan> {
  const sourceRuns = await input.runStore.listSessionRuns(input.sourceSessionId);
  const transcriptTurnIds = [
    ...new Set(
      input.copiedMessages.map(messageTurnId).filter((turnId): turnId is string => !!turnId),
    ),
  ];
  const copyTurnIds = conversationCopyTurnClosure(sourceRuns, transcriptTurnIds);
  const selectedRunEvents = await loadConversationCopyRunEvents(
    sourceRuns,
    input.sourceEvents,
    copyTurnIds,
    input.runtimeEventStore,
  );
  const runs = await Promise.all(
    selectedRunEvents.map(async ({ run, events }) => {
      const operationalEvents = await input.runStore.readEvents(run.sessionId, run.runId);
      if (events.length === 0) {
        throw new Error(`Cannot copy AgentRun ${run.runId} without RuntimeEvent facts`);
      }
      const terminal = classifyTerminalRuntimeLedger(run, events);
      if (isTerminalRunStatus(run.status) && terminal.kind !== 'fact') {
        throw new Error(`Cannot copy terminal AgentRun ${run.runId} without one terminal fact`);
      }
      return { run, runtimeEvents: events, operationalEvents };
    }),
  );
  const plan = {
    sourceSessionId: input.sourceSessionId,
    copyTurnIds,
    inlineRuntimeEvents: [...input.sourceEvents],
    runs,
  };
  assertConversationRuntimeLedgerCopySupported(plan);
  return plan;
}

function assertConversationRuntimeLedgerCopySupported(
  plan: ConversationRuntimeLedgerCopyPlan,
): void {
  const unsupported = plan.runs.some(
    ({ run, runtimeEvents }) =>
      run.continuationSource !== undefined || runtimeEvents.some(isContinuationStartRuntimeEvent),
  );
  if (!unsupported) return;

  const error = new Error(
    'Conversation copy contains durable runtime authority facts that require typed identity rewriting',
  ) as Error & { code: string };
  error.code = 'branch_runtime_fact_rewrite_unsupported';
  throw error;
}

export async function cloneConversationRuntimeLedger(
  input: CloneConversationRuntimeLedgerInput,
): Promise<CloneConversationRuntimeLedgerResult> {
  if (input.plan.sourceSessionId !== input.referenceMap.sourceSessionId) {
    throw new Error('Conversation copy plan does not belong to the source Session');
  }
  const flattenedPlans = input.plan.runs.map(({ run, runtimeEvents, operationalEvents }) => ({
    run,
    events: runtimeEvents,
    operationalEvents,
    terminal: classifyTerminalRuntimeLedger(run, runtimeEvents),
  }));
  const sourceCompactableEvents = sourceCompactableEventsByRunId(
    flattenedPlans,
    input.plan.inlineRuntimeEvents,
  );
  const runIds = new Map(flattenedPlans.map(({ run }) => [run.runId, input.newId()]));
  const targetInvocationIds = new Map(flattenedPlans.map(({ run }) => [run.runId, input.newId()]));
  const invocationIds = new Map(
    flattenedPlans.flatMap(({ run }) =>
      run.invocationId ? [[run.invocationId, targetInvocationIds.get(run.runId)!] as const] : [],
    ),
  );
  const copiedPermissionDecisions = new Map(
    input.copiedMessages.flatMap((message) =>
      message.type === 'permission_decision' ? [[message.id, message] as const] : [],
    ),
  );
  const runtimeEventIds = new Map(
    flattenedPlans.flatMap(({ events }) =>
      events.map((event) => [event.id, input.newId()] as const),
    ),
  );
  const operationalEventIds = new Map(
    flattenedPlans.flatMap(({ operationalEvents }) =>
      operationalEvents.flatMap((event) =>
        isCopiedAgentRunEvent(event) ? [[event.id, input.newId()] as const] : [],
      ),
    ),
  );
  const providerTraceIds = providerTraceIdMap(flattenedPlans, input.newId);
  const operationIds = toolOperationIdMap(flattenedPlans, targetInvocationIds);
  const references: ConversationCopyReferenceMap = {
    ...input.referenceMap,
    runIds,
    invocationIds,
    operationIds,
    runtimeEventIds,
    providerTraceIds,
    agentRunEventIds: operationalEventIds,
  };
  const clonedEventBySourceId = new Map<string, RuntimeEvent>();
  for (const plan of flattenedPlans) {
    const runId = runIds.get(plan.run.runId)!;
    const invocationId = targetInvocationIds.get(plan.run.runId)!;
    for (const event of plan.events) {
      clonedEventBySourceId.set(
        event.id,
        cloneRuntimeEvent(
          event,
          {
            sessionId: input.referenceMap.targetSessionId,
            runId,
            eventId: runtimeEventIds.get(event.id)!,
            invocationId,
          },
          references,
          copiedPermissionDecisions,
        ),
      );
    }
  }
  const checkpointIds = new Map<string, string>();
  const preparedPlans = flattenedPlans.map((plan) => {
    const runId = runIds.get(plan.run.runId)!;
    const invocationId = targetInvocationIds.get(plan.run.runId)!;
    const clonedOperationalEvents = plan.operationalEvents.flatMap((event) => {
      const clonedEvent = cloneAgentRunEvent(
        event,
        {
          sessionId: input.referenceMap.targetSessionId,
          runId,
          eventId: operationalEventIds.get(event.id),
        },
        references,
        sourceCompactableEvents.get(plan.run.runId) ?? [],
        clonedEventBySourceId,
        checkpointIds,
        operationalEventIds,
        providerTraceIds,
      );
      return clonedEvent ? [clonedEvent] : [];
    });
    const terminalEvent =
      plan.terminal.kind === 'fact' && isTerminalRunStatus(plan.run.status)
        ? clonedEventBySourceId.get(plan.terminal.fact.terminalEvent.id)
        : undefined;
    if (plan.terminal.kind === 'fact' && isTerminalRunStatus(plan.run.status) && !terminalEvent) {
      throw new Error(`Copied AgentRun ${plan.run.runId} lost its terminal RuntimeEvent`);
    }
    return {
      plan,
      runId,
      clonedRun: cloneRunHeader(
        plan.run,
        input.referenceMap.targetSessionId,
        runId,
        invocationId,
        references,
      ),
      clonedRuntimeEvents: plan.events.map((event) => clonedEventBySourceId.get(event.id)!),
      clonedOperationalEvents,
      terminalEvent,
    };
  });
  const copiedMessages = input.copiedMessages.map((message) =>
    rewriteConversationCopyMessage(message, references),
  );

  for (const { clonedRun } of preparedPlans) {
    await input.runStore.createRun(clonedRun);
  }

  if (input.runtimeEventStore.importConversationCopyRuntimeEvents) {
    await input.runtimeEventStore.importConversationCopyRuntimeEvents(
      input.referenceMap.targetSessionId,
      preparedPlans.map(({ runId, clonedRuntimeEvents }) => ({
        runId,
        events: clonedRuntimeEvents,
      })),
    );
  } else {
    for (const { runId, clonedRuntimeEvents } of preparedPlans) {
      for (const clonedEvent of clonedRuntimeEvents) {
        await input.runtimeEventStore.appendRuntimeEvent(
          input.referenceMap.targetSessionId,
          runId,
          clonedEvent,
        );
      }
    }
  }

  for (const { plan, runId, clonedOperationalEvents, terminalEvent } of preparedPlans) {
    for (const clonedEvent of clonedOperationalEvents) {
      await input.runStore.appendEvent(input.referenceMap.targetSessionId, runId, clonedEvent);
    }

    if (plan.terminal.kind === 'fact' && isTerminalRunStatus(plan.run.status) && terminalEvent) {
      await commitTerminalRunWithRuntimeFact({
        runStore: input.runStore,
        runtimeEventStore: input.runtimeEventStore,
        newId: input.newId,
        sessionId: input.referenceMap.targetSessionId,
        runId,
        turnId: plan.run.turnId,
        status: plan.terminal.fact.runStatus,
        ts: terminalEvent.ts,
        terminalEvent,
        ...(plan.terminal.fact.failureClass
          ? { failureClass: plan.terminal.fact.failureClass }
          : {}),
        ...(plan.run.failureMessage ? { failureMessage: plan.run.failureMessage } : {}),
        ...(plan.terminal.fact.abortSource ? { abortSource: plan.terminal.fact.abortSource } : {}),
        runEventData: {
          recovered: true,
          recoveryReason: 'conversation_runtime_ledger_clone',
          sourceSessionId: plan.run.sessionId,
          sourceRunId: plan.run.runId,
        },
      });
    }
  }

  return {
    copiedMessages,
    runIdMap: [...runIds].map(([sourceRunId, targetRunId]) => ({
      sourceRunId,
      targetRunId,
    })),
  };
}

interface ConversationCopyRunEvents {
  readonly run: AgentRunHeader;
  readonly events: readonly RuntimeEvent[];
}

async function loadConversationCopyRunEvents(
  sourceRuns: readonly AgentRunHeader[],
  sourceEvents: readonly RuntimeEvent[],
  copyTurnIds: readonly string[],
  runtimeEventStore: Pick<RuntimeEventStore, 'readRuntimeEvents'>,
): Promise<ConversationCopyRunEvents[]> {
  const copiedTurnIds = new Set(copyTurnIds);
  return Promise.all(
    sourceRuns.flatMap((run) => {
      if (!copiedTurnIds.has(run.turnId)) return [];
      const projectedEvents = sourceEvents.filter(
        (event) => event.runId === run.runId && copiedTurnIds.has(event.turnId),
      );
      return [
        Promise.resolve(
          projectedEvents.length > 0
            ? projectedEvents
            : runtimeEventStore.readRuntimeEvents(run.sessionId, run.runId),
        ).then((events) => ({ run, events })),
      ];
    }),
  );
}

export function archivedToolResultContainsConversationOwnedReferences(
  serializedResult: string,
  sourceSessionId: string,
  externalChildReferences?: ReadonlyMap<string, ConversationCopyExternalChildReferences>,
): boolean {
  const value = deserializeToolResultArchive(serializedResult);
  if (isArchivedToolResultPlaceholder(value)) return true;

  let content: ToolResultContent;
  try {
    content = decodeCanonicalToolResultContent(value);
  } catch {
    return false;
  }

  if (content.kind === 'archived_tool_result') return true;
  if (content.kind === 'image') {
    return content.ref.kind === 'session_file' && content.ref.sessionId === sourceSessionId;
  }
  if (content.kind === 'subagent') {
    const [linked] = conversationCopyLinkedChildReferences(content);
    if (linked) {
      return !linkedChildReferencesAreExternal(linked, externalChildReferences);
    }
    return content.runId !== undefined || content.artifactIds.length > 0;
  }
  if (content.kind === 'agent_swarm') {
    if (
      content.items.some(
        (item) =>
          !item.childSessionId &&
          (item.runId !== undefined ||
            item.resumedFromRunId !== undefined ||
            item.artifactIds.length > 0),
      )
    ) {
      return true;
    }
    return conversationCopyLinkedChildReferences(content).some(
      (linked) => !linkedChildReferencesAreExternal(linked, externalChildReferences),
    );
  }
  return false;
}

export function conversationCopyLinkedChildReferences(
  content: ToolResultContent,
): readonly ConversationCopyLinkedChildReference[] {
  if (content.kind === 'subagent') {
    if (!content.childSessionId) return [];
    return [
      {
        childSessionId: content.childSessionId,
        ...(content.runId ? { runId: content.runId } : {}),
        turnId: content.turnId,
        artifactIds: content.artifactIds,
        status: content.status,
        ...(content.failureClass ? { failureClass: content.failureClass } : {}),
      },
    ];
  }
  if (content.kind !== 'agent_swarm') return [];
  return content.items.flatMap((item) =>
    item.childSessionId
      ? [
          {
            childSessionId: item.childSessionId,
            ...(item.runId ? { runId: item.runId } : {}),
            ...(item.resumedFromRunId ? { resumedFromRunId: item.resumedFromRunId } : {}),
            ...(item.turnId ? { turnId: item.turnId } : {}),
            artifactIds: item.artifactIds,
            status: item.status,
            ...(item.failureClass ? { failureClass: item.failureClass } : {}),
          },
        ]
      : [],
  );
}

export function collectConversationCopyLinkedChildReferences(input: {
  readonly messages: readonly StoredMessage[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly archivedResults: readonly string[];
}): readonly ConversationCopyLinkedChildReference[] {
  const references: ConversationCopyLinkedChildReference[] = [];
  const add = (value: unknown): void => {
    if (isArchivedToolResultPlaceholder(value)) return;
    try {
      references.push(
        ...conversationCopyLinkedChildReferences(decodeCanonicalToolResultContent(value)),
      );
    } catch {
      // Opaque tool results have no typed linked-child references.
    }
  };
  for (const message of input.messages) {
    if (message.type === 'tool_result') {
      references.push(...conversationCopyLinkedChildReferences(message.content));
    }
  }
  for (const event of input.runtimeEvents) {
    if (event.content?.kind === 'function_response') add(event.content.result);
  }
  for (const serializedResult of input.archivedResults) {
    add(deserializeToolResultArchive(serializedResult));
  }
  return references;
}

function cloneAgentRunEvent(
  event: AgentRunEvent,
  ids: {
    readonly sessionId: string;
    readonly runId: string;
    readonly eventId?: string;
  },
  references: ConversationCopyReferenceMap,
  sourceCompactableEvents: readonly RuntimeEvent[],
  clonedRuntimeEvents: ReadonlyMap<string, RuntimeEvent>,
  checkpointIds: Map<string, string>,
  operationalEventIds: ReadonlyMap<string, string>,
  providerTraceIds: ReadonlyMap<string, string>,
): EmittedAgentRunEvent | null {
  if (event.type === 'event_corrupt') {
    throw new Error(`Cannot copy corrupt AgentRun event ${event.id}`);
  }
  if (!isCopiedAgentRunEvent(event)) return null;
  if (!ids.eventId) {
    throw new Error(`Cannot copy AgentRun event ${event.id} without a target identity`);
  }

  let data = event.data;
  if (event.type === 'provider_request_captured') {
    data = rewriteProviderRequestCapture(event, ids.eventId, references, providerTraceIds);
  } else if (event.type === 'provider_request_attempt_recorded') {
    data = rewriteProviderRequestAttempt(
      event,
      ids.eventId,
      references,
      operationalEventIds,
      providerTraceIds,
    );
  } else if (event.type === 'history_compact_checkpoint_recorded') {
    const sourceCheckpoint = event.data?.checkpoint;
    if (!validateHistoryCompactCheckpointShape(sourceCheckpoint, event.sessionId)) {
      throw new Error(`Cannot copy invalid history compact checkpoint ${event.id}`);
    }
    // Conversation copies carry the canonical raw RuntimeEvents and can create
    // a fresh checkpoint on demand. Do not export opaque provider state into a
    // new session or degrade it into user-visible placeholder text.
    if (sourceCheckpoint.version === 3) return null;
    const match = matchHistoryCompactCheckpointPrefix(sourceCheckpoint, sourceCompactableEvents);
    if (match.reason) {
      throw new Error(`Cannot copy unmatched history compact checkpoint ${event.id}`);
    }
    // Copy is an admission seam for the sectioned summary contract: a marked
    // checkpoint whose summary no longer satisfies the COMPLETE predicate —
    // including the size floor, re-runnable here because the matched covered
    // span is in hand — must not propagate into a fresh session. Unmarked
    // legacy summaries stay copyable under the truncation-only load policy
    // and keep their unmarked identity in the target.
    if (
      sourceCheckpoint.summaryFormat !== undefined &&
      findCheckpointSummaryDefect(sourceCheckpoint.summary, {
        coveredRuntimeEvents: match.coveredRuntimeEvents,
      }) !== undefined
    ) {
      throw new Error(`Cannot copy invalid history compact checkpoint ${event.id}`);
    }
    const coveredRuntimeEvents = match.coveredRuntimeEvents.map((sourceEvent) => {
      const cloned = clonedRuntimeEvents.get(sourceEvent.id);
      if (!cloned) {
        throw new Error(
          `History compact checkpoint ${event.id} crosses the conversation copy boundary`,
        );
      }
      return cloned;
    });
    const headAnchor =
      sourceCheckpoint.phase === 'mid_turn'
        ? {
            runtimeEventId:
              clonedRuntimeEvents.get(sourceCheckpoint.headAnchor!.runtimeEventId)?.id ??
              sourceCheckpoint.headAnchor!.runtimeEventId,
            turnId: sourceCheckpoint.headAnchor!.turnId,
          }
        : undefined;
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: references.targetSessionId,
      coveredRuntimeEvents,
      summary: sourceCheckpoint.summary,
      summaryFormat: sourceCheckpoint.summaryFormat ?? 'legacy_freeform',
      highWaterName: sourceCheckpoint.highWaterName,
      highWaterSeq: sourceCheckpoint.highWaterSeq,
      now: sourceCheckpoint.createdAt,
      ...(sourceCheckpoint.phase ? { phase: sourceCheckpoint.phase } : {}),
      ...(headAnchor ? { headAnchor } : {}),
      ...(sourceCheckpoint.previousCheckpointId &&
      checkpointIds.has(sourceCheckpoint.previousCheckpointId)
        ? {
            previousCheckpointId: checkpointIds.get(sourceCheckpoint.previousCheckpointId)!,
          }
        : {}),
    });
    checkpointIds.set(sourceCheckpoint.checkpointId, checkpoint.checkpointId);
    data = {
      ...event.data,
      checkpointId: checkpoint.checkpointId,
      checkpoint,
    };
  }

  return {
    ...event,
    id: ids.eventId,
    sessionId: ids.sessionId,
    runId: ids.runId,
    ...(data ? { data } : {}),
  };
}

function rewriteProviderRequestCapture(
  event: AgentRunEvent,
  eventId: string,
  references: ConversationCopyReferenceMap,
  providerTraceIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const data = providerRequestCapture(event);
  return {
    ...data,
    traceId: requiredMappedId(providerTraceIds, data.traceId, 'provider trace'),
    captureId: eventId,
    artifactId: rewriteOwnedArtifactId(data.artifactId, references),
  };
}

function rewriteProviderRequestAttempt(
  event: AgentRunEvent,
  eventId: string,
  references: ConversationCopyReferenceMap,
  operationalEventIds: ReadonlyMap<string, string>,
  providerTraceIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const data = providerRequestAttempt(event);
  return {
    ...data,
    traceId: requiredMappedId(providerTraceIds, data.traceId, 'provider trace'),
    attemptId: eventId,
    captureId: requiredMappedId(operationalEventIds, data.captureId, 'provider request capture'),
    captureArtifactId: rewriteOwnedArtifactId(data.captureArtifactId, references),
  };
}

function providerRequestCapture(event: AgentRunEvent): Record<string, unknown> & {
  readonly traceId: string;
  readonly captureId: string;
  readonly artifactId: string;
} {
  const data = event.data;
  if (
    !data ||
    data.captureId !== event.id ||
    typeof data.traceId !== 'string' ||
    typeof data.artifactId !== 'string'
  ) {
    throw new Error(`Cannot copy invalid provider request capture ${event.id}`);
  }
  return {
    ...data,
    traceId: data.traceId,
    captureId: data.captureId,
    artifactId: data.artifactId,
  };
}

function providerRequestAttempt(event: AgentRunEvent): Record<string, unknown> & {
  readonly traceId: string;
  readonly attemptId: string;
  readonly captureId: string;
  readonly captureArtifactId: string;
} {
  const data = event.data;
  if (
    !data ||
    data.attemptId !== event.id ||
    typeof data.traceId !== 'string' ||
    typeof data.captureId !== 'string' ||
    typeof data.captureArtifactId !== 'string'
  ) {
    throw new Error(`Cannot copy invalid provider request attempt ${event.id}`);
  }
  return {
    ...data,
    traceId: data.traceId,
    attemptId: data.attemptId,
    captureId: data.captureId,
    captureArtifactId: data.captureArtifactId,
  };
}

function requiredMappedId(
  ids: ReadonlyMap<string, string>,
  sourceId: string,
  kind: string,
): string {
  const targetId = ids.get(sourceId);
  if (!targetId) throw new Error(`Conversation copy is missing ${kind} ${sourceId}`);
  return targetId;
}

function rewriteOwnedArtifactId(
  sourceArtifactId: string,
  references: ConversationCopyArtifactReferenceMap,
): string {
  if (references.mode === 'preserve_external') return sourceArtifactId;
  return rewriteOwnedId(sourceArtifactId, references.artifactIds, 'Artifact');
}

function rewriteOwnedId(sourceId: string, ids: ReadonlyMap<string, string>, kind: string): string {
  return requiredMappedId(ids, sourceId, kind);
}

function providerTraceIdMap(
  plans: readonly { readonly operationalEvents: readonly AgentRunEvent[] }[],
  newId: () => string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const { operationalEvents } of plans) {
    for (const event of operationalEvents) {
      if (
        event.type !== 'provider_request_captured' &&
        event.type !== 'provider_request_attempt_recorded'
      ) {
        continue;
      }
      const traceId = event.data?.traceId;
      if (typeof traceId === 'string' && !result.has(traceId)) result.set(traceId, newId());
    }
  }
  return result;
}

function toolOperationIdMap(
  plans: readonly {
    readonly run: AgentRunHeader;
    readonly events: readonly RuntimeEvent[];
  }[],
  targetInvocationIds: ReadonlyMap<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const { run, events } of plans) {
    const invocationId = requiredMappedId(targetInvocationIds, run.runId, 'target invocation');
    for (const event of events) {
      const dispatch = event.actions?.toolDispatch;
      if (!dispatch) continue;
      const targetOperationId = buildToolOperationId({
        invocationId,
        providerToolCallId: dispatch.providerToolCallId,
      });
      const existing = result.get(dispatch.operationId);
      if (existing && existing !== targetOperationId) {
        throw new Error(`Tool operation ${dispatch.operationId} crosses copied AgentRuns`);
      }
      result.set(dispatch.operationId, targetOperationId);
    }
  }
  return result;
}

function isCopiedAgentRunEvent(event: AgentRunEvent): event is EmittedAgentRunEvent {
  // The rewriters below know which of this build's payloads carry source-owned references. A type
  // this build does not emit cannot even be checked for them, so it is dropped rather than carried
  // into the target with source identities intact. The ledger's `type` is open, so such an event
  // may predate a retired writer or postdate this build entirely (#1942).
  if (!isEmittedAgentRunEventType(event.type)) return false;
  // Semantic blocks hash the exact provider-visible source. Rewriting
  // target-owned RuntimeEvent and Artifact references invalidates that
  // evidence, so a copied Session starts without these derived diagnostics.
  return (
    event.type !== 'run_completed' &&
    event.type !== 'run_failed' &&
    event.type !== 'run_cancelled' &&
    event.type !== 'event_corrupt' &&
    event.type !== 'semantic_compact_block_recorded'
  );
}

function cloneRuntimeEvent(
  event: RuntimeEvent,
  ids: {
    readonly sessionId: string;
    readonly runId: string;
    readonly eventId: string;
    readonly invocationId: string;
  },
  references: ConversationCopyReferenceMap,
  copiedPermissionDecisions: ReadonlyMap<
    string,
    Extract<StoredMessage, { type: 'permission_decision' }>
  >,
): RuntimeEvent {
  const rewritten = rewriteRuntimeEventReferences(event, references);
  const cloned: RuntimeEvent = {
    ...rewritten,
    id: ids.eventId,
    invocationId: ids.invocationId,
    sessionId: ids.sessionId,
    runId: ids.runId,
  };
  const accepted = event.actions?.permissionAnswerAccepted;
  const decision = accepted ? copiedPermissionDecisions.get(accepted.requestId) : undefined;
  if (!decision || !cloned.actions) return cloned;
  const { permissionAnswerAccepted: _accepted, ...actions } = cloned.actions;
  cloned.actions = {
    ...actions,
    permissionDecision: {
      requestId: decision.id,
      toolName: decision.toolName,
      decision: decision.decision,
      ...(decision.rememberForTurn !== undefined
        ? { rememberForTurn: decision.rememberForTurn }
        : {}),
      ...(decision.reviewer !== undefined ? { reviewer: decision.reviewer } : {}),
      ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
      ...(decision.riskLevel !== undefined ? { riskLevel: decision.riskLevel } : {}),
    },
  };
  cloned.ts = decision.ts;
  return cloned;
}

function cloneRunHeader(
  source: AgentRunHeader,
  targetSessionId: string,
  runId: string,
  invocationId: string,
  references: ConversationCopyReferenceMap,
): AgentRunHeader {
  const cloned: AgentRunHeader = {
    ...source,
    invocationId,
    sessionId: targetSessionId,
    runId,
    ...(source.parentRunId
      ? { parentRunId: rewriteOwnedId(source.parentRunId, references.runIds, 'AgentRun') }
      : {}),
    ...(source.resumedFromRunId
      ? {
          resumedFromRunId: rewriteOwnedId(source.resumedFromRunId, references.runIds, 'AgentRun'),
        }
      : {}),
    ...(source.retriedFromRunId
      ? {
          retriedFromRunId: rewriteOwnedId(source.retriedFromRunId, references.runIds, 'AgentRun'),
        }
      : {}),
    ...(source.parentSessionId === references.sourceSessionId
      ? { parentSessionId: targetSessionId }
      : {}),
    ...(source.continuationSource
      ? {
          continuationSource: {
            ...source.continuationSource,
            sourceInvocationId: rewriteOwnedId(
              source.continuationSource.sourceInvocationId,
              references.invocationIds,
              'invocation',
            ),
            sourceRunId: rewriteOwnedId(
              source.continuationSource.sourceRunId,
              references.runIds,
              'AgentRun',
            ),
          },
        }
      : {}),
  };
  if (isTerminalRunStatus(source.status)) {
    cloned.status = 'running';
    delete cloned.completedAt;
    delete cloned.failureClass;
    delete cloned.failureMessage;
    delete cloned.abortSource;
  }
  return cloned;
}

function rewriteRuntimeEventReferences(
  event: RuntimeEvent,
  references: ConversationCopyReferenceMap,
): RuntimeEvent {
  const content =
    event.content?.kind === 'text' && event.content.attachments
      ? {
          ...event.content,
          attachments: event.content.attachments.map((attachment) => ({
            ...attachment,
            ref: rewriteStorageRef(attachment.ref, references),
          })),
        }
      : event.content?.kind === 'function_response'
        ? {
            ...event.content,
            result: rewriteRuntimeToolResult(event.content.result, references),
          }
        : event.content;
  const refs = event.refs
    ? (() => {
        const { operationId: _operationId, traceEventId: _traceEventId, ...preserved } = event.refs;
        const traceEventId = event.refs.traceEventId
          ? references.agentRunEventIds.get(event.refs.traceEventId)
          : undefined;
        return {
          ...preserved,
          ...(traceEventId ? { traceEventId } : {}),
          ...(event.refs.operationId
            ? {
                operationId: rewriteOwnedId(
                  event.refs.operationId,
                  references.operationIds,
                  'tool operation',
                ),
              }
            : {}),
          ...(event.refs.artifactId
            ? {
                artifactId: rewriteOwnedArtifactId(event.refs.artifactId, references),
              }
            : {}),
          ...(event.refs.sourceInvocationId
            ? {
                sourceInvocationId: rewriteOwnedId(
                  event.refs.sourceInvocationId,
                  references.invocationIds,
                  'invocation',
                ),
              }
            : {}),
          ...(event.refs.sourceRunId
            ? {
                sourceRunId: rewriteOwnedId(event.refs.sourceRunId, references.runIds, 'AgentRun'),
              }
            : {}),
          ...(event.refs.providerRequestTraceId
            ? {
                providerRequestTraceId: rewriteOwnedId(
                  event.refs.providerRequestTraceId,
                  references.providerTraceIds,
                  'provider trace',
                ),
              }
            : {}),
        };
      })()
    : undefined;
  const actions = rewriteRuntimeEventActions(event.actions, references);
  return {
    ...event,
    ...(content ? { content } : {}),
    ...(actions ? { actions } : {}),
    ...(refs ? { refs } : {}),
  };
}

function rewriteRuntimeEventActions(
  actions: RuntimeEvent['actions'],
  references: ConversationCopyReferenceMap,
): RuntimeEvent['actions'] {
  const dispatch = actions?.toolDispatch;
  const recovery = actions?.toolRecovery;
  if (!dispatch && !recovery) return actions;
  const operationId = dispatch?.operationId ?? recovery?.payload.operationId;
  const targetOperationId = operationId
    ? rewriteOwnedId(operationId, references.operationIds, 'tool operation')
    : undefined;
  return {
    ...actions,
    ...(dispatch && targetOperationId
      ? { toolDispatch: { ...dispatch, operationId: targetOperationId } }
      : {}),
    ...(recovery && targetOperationId
      ? {
          toolRecovery: rewriteToolRecoveryFact(recovery, targetOperationId, references),
        }
      : {}),
  };
}

function rewriteToolRecoveryFact(
  recovery: NonNullable<RuntimeEvent['actions']>['toolRecovery'],
  operationId: string,
  references: ConversationCopyReferenceMap,
): NonNullable<RuntimeEvent['actions']>['toolRecovery'] {
  if (!recovery || recovery.kind !== TOOL_RECOVERY_DECISION_FACT_KIND) {
    return recovery ? { ...recovery, payload: { ...recovery.payload, operationId } } : recovery;
  }
  const payload = recovery.payload;
  return {
    ...recovery,
    payload: {
      ...payload,
      operationId,
      evidenceEventIds: payload.evidenceEventIds.map((eventId) =>
        requiredMappedId(references.runtimeEventIds, eventId, 'RuntimeEvent'),
      ),
      ...(payload.disposition === 'completed'
        ? {
            outcomeEventId: requiredMappedId(
              references.runtimeEventIds,
              payload.outcomeEventId,
              'RuntimeEvent',
            ),
          }
        : {}),
    },
  };
}

function rewriteToolResultContent(
  content: ToolResultContent,
  references: ConversationCopyMessageReferenceMap,
): ToolResultContent {
  if (content.kind === 'image') {
    return { ...content, ref: rewriteStorageRef(content.ref, references) };
  }
  if (content.kind === 'archived_tool_result') {
    return {
      ...content,
      runtimeEventId: rewriteOwnedId(
        content.runtimeEventId,
        references.runtimeEventIds,
        'RuntimeEvent',
      ),
      ...(content.artifactId
        ? { artifactId: rewriteOwnedArtifactId(content.artifactId, references) }
        : {}),
    };
  }
  if (content.kind === 'json' && isArchivedToolResultPlaceholder(content.value)) {
    return {
      ...content,
      value: rewriteArchivedToolResult(content.value, references),
    };
  }
  if (content.kind === 'subagent') {
    return {
      ...content,
      ...(content.runId
        ? {
            runId: rewriteLinkedRunId(
              content.runId,
              content.childSessionId,
              references,
              'AgentRun',
            ),
          }
        : {}),
      artifactIds: rewriteLinkedArtifactIds(
        content.artifactIds,
        content.childSessionId,
        references,
      ),
    };
  }
  if (content.kind === 'agent_swarm') {
    return {
      ...content,
      items: content.items.map((item) => {
        return {
          ...item,
          ...(item.runId
            ? {
                runId: rewriteLinkedRunId(item.runId, item.childSessionId, references, 'AgentRun'),
              }
            : {}),
          ...(item.resumedFromRunId
            ? {
                resumedFromRunId: rewriteLinkedRunId(
                  item.resumedFromRunId,
                  item.childSessionId,
                  references,
                  'resumed AgentRun',
                ),
              }
            : {}),
          artifactIds: rewriteLinkedArtifactIds(item.artifactIds, item.childSessionId, references),
        };
      }),
    };
  }
  return content;
}

function rewriteRuntimeToolResult(
  value: unknown,
  references: ConversationCopyMessageReferenceMap,
): unknown {
  if (isArchivedToolResultPlaceholder(value)) {
    return rewriteArchivedToolResult(value, references);
  }
  let content: ToolResultContent;
  try {
    content = decodeCanonicalToolResultContent(value);
  } catch {
    return value;
  }
  return rewriteToolResultContent(content, references);
}

function rewriteArtifactIds(
  artifactIds: readonly string[],
  references: ConversationCopyArtifactReferenceMap,
): readonly string[] {
  return artifactIds.map((artifactId) => rewriteOwnedArtifactId(artifactId, references));
}

function validatedExternalChildReferences(
  childSessionId: string,
  references: ConversationCopyMessageReferenceMap,
): ConversationCopyExternalChildReferences | undefined {
  if (references.mode === 'preserve_external') return undefined;
  if (references.linkedChildren.mode === 'reject') {
    throw new Error(`Conversation copy cannot retain linked child Session ${childSessionId}`);
  }
  const external = references.linkedChildren.references.get(childSessionId);
  if (!external) {
    throw new Error(`Conversation copy is missing linked child Session ${childSessionId}`);
  }
  return external;
}

function rewriteLinkedRunId(
  sourceId: string,
  childSessionId: string | undefined,
  references: ConversationCopyMessageReferenceMap,
  kind: string,
): string {
  if (!childSessionId) return rewriteOwnedId(sourceId, references.runIds, kind);
  const external = validatedExternalChildReferences(childSessionId, references);
  return external ? preserveExternalId(sourceId, external.runIds, kind) : sourceId;
}

function rewriteLinkedArtifactIds(
  sourceIds: readonly string[],
  childSessionId: string | undefined,
  references: ConversationCopyMessageReferenceMap,
): readonly string[] {
  if (!childSessionId) return rewriteArtifactIds(sourceIds, references);
  const external = validatedExternalChildReferences(childSessionId, references);
  return external ? preserveExternalIds(sourceIds, external.artifactIds, 'Artifact') : sourceIds;
}

function preserveExternalIds(
  sourceIds: readonly string[],
  externalIds: ReadonlySet<string>,
  kind: string,
): readonly string[] {
  return sourceIds.map((sourceId) => preserveExternalId(sourceId, externalIds, kind));
}

function preserveExternalId(
  sourceId: string,
  externalIds: ReadonlySet<string>,
  kind: string,
): string {
  if (!externalIds.has(sourceId)) {
    throw new Error(`Conversation copy is missing external ${kind} ${sourceId}`);
  }
  return sourceId;
}

function linkedChildReferencesAreExternal(
  linked: ConversationCopyLinkedChildReference,
  externalChildReferences?: ReadonlyMap<string, ConversationCopyExternalChildReferences>,
): boolean {
  const external = externalChildReferences?.get(linked.childSessionId);
  return (
    external !== undefined &&
    [linked.runId, linked.resumedFromRunId]
      .filter((id): id is string => !!id)
      .every((runId) => external.runIds.has(runId)) &&
    linked.artifactIds.every((artifactId) => external.artifactIds.has(artifactId))
  );
}

function rewriteStorageRef(
  ref: StorageRef,
  references: ConversationCopyArtifactReferenceMap,
): StorageRef {
  if (ref.kind !== 'session_file' || ref.sessionId !== references.sourceSessionId) return ref;
  if (references.mode === 'preserve_external') return ref;
  const relativePath = references.relativePaths.get(ref.relativePath);
  if (!relativePath) {
    throw new Error(`Conversation copy is missing Session file ${ref.relativePath}`);
  }
  return {
    ...ref,
    sessionId: references.targetSessionId,
    relativePath,
  };
}

function rewriteArchivedToolResult(
  value: ArchivedToolResultPlaceholder,
  references: ConversationCopyMessageReferenceMap,
): ArchivedToolResultPlaceholder {
  const artifactId = rewriteOwnedArtifactId(value.artifactId, references);
  const resource = value.resourceRef
    ? parseToolResultArchiveResourceRef(value.resourceRef)
    : undefined;
  return {
    ...value,
    runtimeEventId: rewriteOwnedId(
      value.runtimeEventId,
      references.runtimeEventIds,
      'RuntimeEvent',
    ),
    artifactId,
    ...(resource && artifactId !== value.artifactId
      ? {
          resourceRef: buildToolResultArchiveResourceRef({
            ...resource,
            artifactId,
          }),
        }
      : {}),
  };
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
}

function conversationCopyTurnClosure(
  runs: readonly AgentRunHeader[],
  retainedTurnIds: readonly string[],
): string[] {
  const result = [...new Set(retainedTurnIds)];
  const includedTurnIds = new Set(result);
  const includedRunIds = new Set(
    runs.filter((run) => includedTurnIds.has(run.turnId)).map((run) => run.runId),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const run of runs) {
      if (
        isSessionInlineRun(run) ||
        !run.parentRunId ||
        !includedRunIds.has(run.parentRunId) ||
        includedRunIds.has(run.runId)
      ) {
        continue;
      }
      includedRunIds.add(run.runId);
      if (!includedTurnIds.has(run.turnId)) {
        includedTurnIds.add(run.turnId);
        result.push(run.turnId);
      }
      changed = true;
    }
  }
  return result;
}

function sourceCompactableEventsByRunId(
  plans: readonly {
    readonly run: AgentRunHeader;
    readonly events: readonly RuntimeEvent[];
  }[],
  sessionEvents: readonly RuntimeEvent[],
): ReadonlyMap<string, readonly RuntimeEvent[]> {
  const plansByRunId = new Map(plans.map((plan) => [plan.run.runId, plan]));
  const inlineEvents = sessionEvents.filter(isHistoryCompactContentEvent);
  const result = new Map<string, readonly RuntimeEvent[]>();

  for (const plan of plans) {
    if (isSessionInlineRun(plan.run)) {
      result.set(plan.run.runId, inlineEvents);
      continue;
    }

    const reverseChain = [];
    const visited = new Set<string>();
    let cursor: (typeof plans)[number] | undefined = plan;
    while (cursor) {
      if (visited.has(cursor.run.runId)) {
        throw new Error(
          `Conversation copy child resume lineage contains a cycle at ${cursor.run.runId}`,
        );
      }
      visited.add(cursor.run.runId);
      reverseChain.push(cursor);
      const sourceRunId = cursor.run.resumedFromRunId;
      if (!sourceRunId) break;
      cursor = plansByRunId.get(sourceRunId);
      if (!cursor) {
        throw new Error(
          `Conversation copy child resume source ${sourceRunId} crosses the copy boundary`,
        );
      }
    }
    result.set(
      plan.run.runId,
      reverseChain
        .reverse()
        .flatMap((item) => item.events)
        .filter(isHistoryCompactContentEvent),
    );
  }

  return result;
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
