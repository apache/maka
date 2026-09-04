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
import { type StorageRef, type ToolResultContent } from '@maka/core/events';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { markPersisted } from '@maka/core/persisted-value';
import type { StoredMessage } from '@maka/core/session';
import { decodePersistedToolResultContent } from '@maka/core/tool-result-record-schema';
import { isEmittedAgentRunEventType, isSessionInlineRun } from '@maka/core/agent-run';
import {
  decodeModelCallAttempt,
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
} from '@maka/core/model-call-attempt';
import { TOOL_RECOVERY_DECISION_FACT_KIND } from '@maka/core/tool-recovery-fact';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from './history-compact-checkpoint.js';
import { findCheckpointSummaryDefect } from './history-compact-summary-validation.js';
import { isHistoryCompactContentEvent } from './history-compaction.js';
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
import { rewriteDurableToolResultProjectionArtifactRefs } from './durable-tool-result-projection.js';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import {
  buildModelProjectionTransition,
  decodeModelProjectionTransition,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import {
  baseToolResultProjection,
  decodeLedgerTransition,
  reduceEffectiveModelProjections,
} from './model-projection-transition-ledger.js';
import { archivedToolResultProjection } from './tool-result-archive-transition.js';

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
      readonly contextRefs?: ReadonlyMap<string, string>;
      readonly linkedChildren:
        | { readonly mode: 'reject' }
        | {
            readonly mode: 'snapshot';
            readonly archivedResults: ReadonlyMap<string, string>;
          }
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
    importConversationCopyRuntimeEvents(
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

interface ConversationCopyStorageReferenceInput {
  readonly messages: readonly StoredMessage[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly archivedResults: readonly string[];
}

/** Walks every typed StorageRef site reached by conversation-copy rewriting. */
function collectConversationCopyStorageRefs(
  input: ConversationCopyStorageReferenceInput,
): readonly StorageRef[] {
  const refs: StorageRef[] = [];
  const addContent = (content: ToolResultContent): void => {
    if (content.kind === 'image') refs.push(content.ref);
  };
  const addSerialized = (value: unknown): void => {
    if (isArchivedToolResultPlaceholder(value)) return;
    try {
      addContent(decodePersistedToolResultContent(markPersisted<ToolResultContent>(value)));
    } catch {
      // Opaque tool results carry no typed StorageRef.
    }
  };
  for (const message of input.messages) {
    if (message.type === 'user' && message.attachments) {
      for (const attachment of message.attachments) refs.push(attachment.ref);
    } else if (message.type === 'tool_result') {
      addContent(message.content);
    }
  }
  for (const event of input.runtimeEvents) {
    if (event.content?.kind === 'text' && event.content.attachments) {
      for (const attachment of event.content.attachments) refs.push(attachment.ref);
    } else if (event.content?.kind === 'function_response') {
      addSerialized(event.content.result);
    }
  }
  for (const serializedResult of input.archivedResults) {
    addSerialized(deserializeToolResultArchive(serializedResult));
  }
  return refs;
}

/** Finds durable Session context references that the exact copy will rewrite. */
export function collectConversationCopySessionContextRefIds(input: {
  readonly sourceSessionId: string;
  readonly messages: readonly StoredMessage[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly archivedResults: readonly string[];
}): readonly string[] {
  const refIds = new Set<string>();
  for (const ref of collectConversationCopyStorageRefs(input)) {
    if (ref.kind === 'session_context' && ref.sessionId === input.sourceSessionId) {
      refIds.add(ref.refId);
    }
  }
  return [...refIds].sort();
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
  if (message.type === 'assistant' && references.mode === 'exact') {
    return {
      ...message,
      text: rewriteAttachmentResourceRefs(message.text, references.artifactIds),
    };
  }
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

function rewriteAttachmentResourceRefs(
  text: string,
  artifactIds: ReadonlyMap<string, string>,
): string {
  return text.replace(/maka:\/\/runtime\/attachments\/[^\s)\]}>`'",;:!]+/g, (candidate) => {
    const parsed = parseAttachmentResourceRef(candidate);
    const artifactId = parsed ? artifactIds.get(parsed.artifactId) : undefined;
    return artifactId ? `maka://runtime/attachments/${artifactId}` : candidate;
  });
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
  await rebuildCopiedProjectionTransitions(input.sourceSessionId, sourceRuns, runs, input.runStore);
  const plan = {
    sourceSessionId: input.sourceSessionId,
    copyTurnIds,
    inlineRuntimeEvents: [...input.sourceEvents],
    runs,
  };
  assertConversationRuntimeLedgerCopySupported(plan);
  return plan;
}

/**
 * Rebuild the copied slice's transition records from the source fold.
 *
 * Two things make "copy the records you happen to hold" wrong. A transition is
 * recorded by the run that decided it, which for a prior-Turn archive is a
 * LATER run than the one holding its target — so copying by run keeps the
 * target and drops the record that replaced it. And a ledger holds records the
 * source fold refused: rival roots resolved by content-derived id, stale
 * writers. Carrying those lets the copy re-decide and make a source-rejected
 * transition model-visible.
 *
 * So the source reduction is the authority here too: every record for a copied
 * target is gathered, folded, and only the applied chain is kept, in the order
 * the fold applied it.
 */
async function rebuildCopiedProjectionTransitions(
  sessionId: string,
  sourceRuns: readonly AgentRunHeader[],
  runs: readonly {
    readonly run: AgentRunHeader;
    readonly runtimeEvents: readonly RuntimeEvent[];
    readonly operationalEvents: AgentRunEvent[];
  }[],
  runStore: Pick<AgentRunStore, 'readEvents'>,
): Promise<void> {
  const owningRun = new Map<string, { run: AgentRunHeader; operationalEvents: AgentRunEvent[] }>();
  const copiedRuntimeEvents: RuntimeEvent[] = [];
  for (const { run, runtimeEvents, operationalEvents } of runs) {
    for (const event of runtimeEvents) {
      owningRun.set(event.id, { run, operationalEvents });
      copiedRuntimeEvents.push(event);
    }
  }

  const ledgerEvents = new Map<string, AgentRunEvent>();
  const transitions: ModelProjectionTransition[] = [];
  const collect = (events: readonly AgentRunEvent[]): void => {
    for (const event of events) {
      const transition = decodeLedgerTransition(event, sessionId);
      if (!transition || !owningRun.has(transition.target.runtimeEventId)) continue;
      if (ledgerEvents.has(transition.transitionId)) continue;
      ledgerEvents.set(transition.transitionId, event);
      transitions.push(transition);
    }
  };
  const copiedRunIds = new Set(runs.map(({ run }) => run.runId));
  for (const { operationalEvents } of runs) collect(operationalEvents);
  for (const run of sourceRuns) {
    if (copiedRunIds.has(run.runId)) continue;
    collect(await runStore.readEvents(sessionId, run.runId));
  }
  if (transitions.length === 0) return;

  // Records this build cannot decode are not gathered above, so the copy would
  // silently lose whatever they removed. Refuse instead.
  for (const run of sourceRuns) {
    for (const event of copiedRunIds.has(run.runId)
      ? runs.find(({ run: copied }) => copied.runId === run.runId)!.operationalEvents
      : await runStore.readEvents(sessionId, run.runId)) {
      if (
        event.type === MODEL_PROJECTION_TRANSITION_EVENT_TYPE &&
        !decodeLedgerTransition(event, sessionId) &&
        typeof event.data?.runtimeEventId === 'string' &&
        owningRun.has(event.data.runtimeEventId)
      ) {
        throw new Error(
          `Cannot copy a conversation whose projection transition ${event.id} is unreadable`,
        );
      }
    }
  }

  for (const { operationalEvents } of runs) {
    for (let index = operationalEvents.length - 1; index >= 0; index -= 1) {
      if (operationalEvents[index]!.type === MODEL_PROJECTION_TRANSITION_EVENT_TYPE) {
        operationalEvents.splice(index, 1);
      }
    }
  }
  for (const transition of reduceEffectiveModelProjections(copiedRuntimeEvents, transitions)
    .applied) {
    const owner = owningRun.get(transition.target.runtimeEventId)!;
    const event = ledgerEvents.get(transition.transitionId)!;
    // The record moves to the run that owns its target, so the copy keeps one
    // rule for every operational event: an event belongs to the run it is in.
    owner.operationalEvents.push({ ...event, runId: owner.run.runId, turnId: owner.run.turnId });
  }
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
  const logicalCallIds = logicalModelCallIdMap(flattenedPlans, input.newId);
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
  // Transition lineage across the copy boundary: source transition id -> target
  // id, plus the effective projection each target has reached, so a chained
  // successor is rebuilt against the projection it actually replaces.
  const transitionIds = new Map<string, string>();
  const transitionState = new Map<
    string,
    { projection: DurableToolResultProjection; transitionId: string }
  >();
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
        transitionIds,
        transitionState,
        operationalEventIds,
        providerTraceIds,
        logicalCallIds,
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

  const importedSourceEventIds = new Set<string>();
  const orderedBatches = input.plan.inlineRuntimeEvents.flatMap((event) => {
    const cloned = clonedEventBySourceId.get(event.id);
    const runId = runIds.get(event.runId);
    if (!cloned || !runId) return [];
    importedSourceEventIds.add(event.id);
    return [{ runId, events: [cloned] }];
  });
  for (const { plan, runId } of preparedPlans) {
    const remaining = plan.events.filter((event) => !importedSourceEventIds.has(event.id));
    if (remaining.length === 0) continue;
    orderedBatches.push({
      runId,
      events: remaining.map((event) => clonedEventBySourceId.get(event.id)!),
    });
  }
  await input.runtimeEventStore.importConversationCopyRuntimeEvents(
    input.referenceMap.targetSessionId,
    orderedBatches,
  );

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
    content = decodePersistedToolResultContent(markPersisted<ToolResultContent>(value));
  } catch {
    return false;
  }

  if (content.kind === 'archived_tool_result') return true;
  if (content.kind === 'image') {
    return (
      (content.ref.kind === 'session_file' || content.ref.kind === 'session_context') &&
      content.ref.sessionId === sourceSessionId
    );
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

export function archivedToolResultContainsLinkedChildReferences(serializedResult: string): boolean {
  const value = deserializeToolResultArchive(serializedResult);
  if (isArchivedToolResultPlaceholder(value)) return false;
  try {
    return (
      conversationCopyLinkedChildReferences(
        decodePersistedToolResultContent(markPersisted<ToolResultContent>(value)),
      ).length > 0
    );
  } catch {
    return false;
  }
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
        ...conversationCopyLinkedChildReferences(
          decodePersistedToolResultContent(markPersisted<ToolResultContent>(value)),
        ),
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

/**
 * Collects the `relativePath` of every `session_file` StorageRef that the copied
 * slice references and that belongs to the source Session. User-uploaded
 * attachments carry `turnId === uploadId` (a sentinel, not a conversation turn),
 * so the turn-scoped artifact copy never selects them; the coordinator feeds this
 * set to `copyConversationArtifacts` as an explicit same-Session include list so
 * their refs resolve in `rewriteStorageRef`. Walks exactly the ref sites reached
 * by `rewriteStorageRef`: user-message attachments, tool_result image refs, text
 * runtime-event attachments, and function_response / archived tool-result images.
 */
export function collectConversationCopySessionFileRefs(input: {
  readonly sourceSessionId: string;
  readonly messages: readonly StoredMessage[];
  readonly runtimeEvents: readonly RuntimeEvent[];
  readonly archivedResults: readonly string[];
}): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const ref of collectConversationCopyStorageRefs(input)) {
    if (ref.kind === 'session_file' && ref.sessionId === input.sourceSessionId) {
      refs.add(ref.relativePath);
    }
  }
  return refs;
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
  transitionIds: Map<string, string>,
  transitionState: Map<string, { projection: DurableToolResultProjection; transitionId: string }>,
  operationalEventIds: ReadonlyMap<string, string>,
  providerTraceIds: ReadonlyMap<string, string>,
  logicalCallIds: ReadonlyMap<string, string>,
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
  } else if (event.type === MODEL_CALL_ATTEMPT_EVENT_TYPE) {
    data = rewriteModelCallAttempt(
      event,
      { sessionId: ids.sessionId, runId: ids.runId, attemptId: ids.eventId },
      references,
      providerTraceIds,
      logicalCallIds,
    );
  } else if (event.type === 'history_compact_checkpoint_recorded') {
    const sourceCheckpoint = event.data?.checkpoint;
    // Conversation copies carry the canonical raw RuntimeEvents and can create
    // a fresh checkpoint on demand, so a checkpoint this Runtime can no longer
    // hold to its own contract is DROPPED, never fatal: the copy is complete
    // without it. That covers opaque provider state (do not export it into a
    // new session or degrade it into user-visible placeholder text), a
    // superseded source policy, and a prefix that no longer matches. A ledger
    // keeps every checkpoint it ever recorded, so a session that compacted
    // under an older policy would otherwise be permanently uncopyable.
    if (!validateHistoryCompactCheckpointShape(sourceCheckpoint, event.sessionId)) return null;
    if (sourceCheckpoint.version === 3) return null;
    const match = matchHistoryCompactCheckpointPrefix(sourceCheckpoint, sourceCompactableEvents);
    if (match.reason) return null;
    // Copy is an admission seam for the sectioned summary contract: a marked
    // checkpoint whose summary no longer satisfies the COMPLETE predicate —
    // re-runnable here on structure and truncation (the size floor needs the
    // summarizer call's usage, which a copy does not have) — must not
    // propagate into a fresh session. Unmarked legacy summaries stay copyable
    // under the truncation-only load policy and keep their unmarked identity
    // in the target.
    if (
      sourceCheckpoint.summaryFormat !== undefined &&
      findCheckpointSummaryDefect(sourceCheckpoint.summary) !== undefined
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
  } else if (event.type === MODEL_PROJECTION_TRANSITION_EVENT_TYPE) {
    const cloned = cloneModelProjectionTransition(
      event,
      references,
      clonedRuntimeEvents,
      transitionIds,
      transitionState,
    );
    // Every transition whose target is in the copied slice was gathered into
    // this run's ledger, wherever it was recorded. So a transition that finds no
    // cloned target has genuinely lost its target as well, and dropping it
    // cannot bring replaced content back.
    if (!cloned) return null;
    data = { ...event.data, transition: cloned, runtimeEventId: cloned.target.runtimeEventId };
  }

  return {
    ...event,
    id: ids.eventId,
    sessionId: ids.sessionId,
    runId: ids.runId,
    ...(data ? { data } : {}),
  };
}

/**
 * Rebuild one projection transition inside the target Session.
 *
 * A transition is a claim about a specific projection of a specific event, so a
 * copy cannot carry it verbatim: the target's RuntimeEvent id, artifact ids and
 * therefore its projection digest are all different. Rebuilding it re-derives
 * the digest from the CLONED event, which also means a copy that failed to
 * remap something cannot silently produce an inert transition — the replaced
 * content would come back, so the mismatch throws instead.
 */
function cloneModelProjectionTransition(
  event: AgentRunEvent,
  references: ConversationCopyReferenceMap,
  clonedRuntimeEvents: ReadonlyMap<string, RuntimeEvent>,
  transitionIds: Map<string, string>,
  transitionState: Map<string, { projection: DurableToolResultProjection; transitionId: string }>,
): ModelProjectionTransition | null {
  let source: ModelProjectionTransition;
  try {
    source = decodeModelProjectionTransition(event.data?.transition, event.sessionId);
  } catch {
    throw new Error(`Cannot copy invalid model projection transition ${event.id}`);
  }
  const clonedTarget = clonedRuntimeEvents.get(source.target.runtimeEventId);
  if (!clonedTarget) return null;
  const placeholder = source.replacement.kind === 'json' ? source.replacement.value : undefined;
  if (!isArchivedToolResultPlaceholder(placeholder)) {
    throw new Error(`Cannot copy unsupported model projection transition ${event.id}`);
  }
  const existing = transitionState.get(clonedTarget.id);
  const sourceProjection = existing?.projection ?? baseToolResultProjection(clonedTarget);
  if (!sourceProjection) {
    throw new Error(`Cannot copy model projection transition ${event.id} onto its target`);
  }
  const rewritten = rewriteArchivedToolResult(placeholder, references);
  const transition = buildModelProjectionTransition({
    sessionId: references.targetSessionId,
    target: {
      runtimeEventId: clonedTarget.id,
      part: 'tool_result',
      toolCallId: source.target.toolCallId,
      toolName: source.target.toolName,
    },
    sourceProjection,
    replacement: archivedToolResultProjection(rewritten),
    // The applied chain is copied in fold order, so a predecessor is always
    // rebuilt before its successor. An unmapped one means the chain broke, and
    // rooting the successor instead would change what the fold decides.
    ...(source.previousTransitionId
      ? {
          previousTransitionId: requiredMappedId(
            transitionIds,
            source.previousTransitionId,
            'model projection transition',
          ),
        }
      : {}),
    now: source.createdAt,
  });
  transitionIds.set(source.transitionId, transition.transitionId);
  transitionState.set(clonedTarget.id, {
    projection: transition.replacement,
    transitionId: transition.transitionId,
  });
  return transition;
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
    ...(data.captureId !== undefined && data.captureArtifactId !== undefined
      ? {
          captureId: requiredMappedId(
            operationalEventIds,
            data.captureId,
            'provider request capture',
          ),
          captureArtifactId: rewriteOwnedArtifactId(data.captureArtifactId, references),
        }
      : {}),
  };
}

function rewriteModelCallAttempt(
  event: AgentRunEvent,
  ids: {
    readonly sessionId: string;
    readonly runId: string;
    readonly attemptId: string;
  },
  references: ConversationCopyReferenceMap,
  providerTraceIds: ReadonlyMap<string, string>,
  logicalCallIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  // A ModelCallAttempt is an accounting authority whose payload identity is its
  // portable source of truth and must agree with the rewritten envelope. Leaving
  // the source `sessionId`/`runId` in place makes the model-call projection
  // reject the attempt as unreadable (its envelope now disagrees), and reusing
  // the source `attemptId` — the ledger's global primary key — lets the copy
  // overwrite the source session's own row. Rewrite the owned identity the same
  // way the sibling provider-request rewriters do.
  //
  // Unlike those siblings, do NOT require `attempt.attemptId === event.id`. A
  // well-formed writer emits them equal, but the pre-fix copy path had no
  // rewriter for this event, so it rewrote the envelope id while leaving the
  // nested payload at the source identity. Sessions copied before that fix carry
  // attempts whose nested `attemptId` disagrees with their envelope; asserting
  // the writer contract on the *source* would strand them — they could never be
  // copied again. The rewrite below reassigns the identity wholesale, so a stale
  // nested identity is repaired rather than trusted and the *output* still
  // satisfies the `event.id === attemptId` contract. `decodeModelCallAttempt`
  // still rejects a schema-invalid payload.
  const attempt = decodeModelCallAttempt(event.data);
  return {
    ...attempt,
    sessionId: ids.sessionId,
    runId: ids.runId,
    attemptId: ids.attemptId,
    logicalCallId: requiredMappedId(logicalCallIds, attempt.logicalCallId, 'logical model call'),
    traceId: requiredMappedId(providerTraceIds, attempt.traceId, 'provider trace'),
    ...(attempt.captureArtifactId !== undefined
      ? { captureArtifactId: rewriteOwnedArtifactId(attempt.captureArtifactId, references) }
      : {}),
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
  readonly captureId?: string;
  readonly captureArtifactId?: string;
} {
  const data = event.data;
  const hasCaptureId = typeof data?.captureId === 'string';
  const hasArtifactId = typeof data?.captureArtifactId === 'string';
  if (
    !data ||
    data.attemptId !== event.id ||
    typeof data.traceId !== 'string' ||
    hasCaptureId !== hasArtifactId
  ) {
    throw new Error(`Cannot copy invalid provider request attempt ${event.id}`);
  }
  return {
    ...data,
    traceId: data.traceId,
    attemptId: data.attemptId,
    ...(hasCaptureId && hasArtifactId
      ? { captureId: data.captureId as string, captureArtifactId: data.captureArtifactId as string }
      : {}),
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
        event.type !== 'provider_request_attempt_recorded' &&
        event.type !== MODEL_CALL_ATTEMPT_EVENT_TYPE
      ) {
        continue;
      }
      const traceId = event.data?.traceId;
      if (typeof traceId === 'string' && !result.has(traceId)) result.set(traceId, newId());
    }
  }
  return result;
}

function logicalModelCallIdMap(
  plans: readonly { readonly operationalEvents: readonly AgentRunEvent[] }[],
  newId: () => string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const { operationalEvents } of plans) {
    for (const event of operationalEvents) {
      if (event.type !== MODEL_CALL_ATTEMPT_EVENT_TYPE) continue;
      const logicalCallId = event.data?.logicalCallId;
      if (typeof logicalCallId === 'string' && !result.has(logicalCallId)) {
        result.set(logicalCallId, newId());
      }
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
  return (
    event.type !== 'run_completed' &&
    event.type !== 'run_failed' &&
    event.type !== 'run_cancelled' &&
    event.type !== 'event_corrupt'
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
    event.content?.kind === 'text'
      ? {
          ...event.content,
          ...(references.mode === 'exact'
            ? { text: rewriteAttachmentResourceRefs(event.content.text, references.artifactIds) }
            : {}),
          ...(event.content.attachments
            ? {
                attachments: event.content.attachments.map((attachment) => ({
                  ...attachment,
                  ref: rewriteStorageRef(attachment.ref, references),
                })),
              }
            : {}),
        }
      : event.content?.kind === 'function_response'
        ? {
            ...event.content,
            result: rewriteRuntimeToolResult(event.content.result, references),
            ...(event.content.modelProjection
              ? {
                  modelProjection: rewriteDurableToolResultProjectionArtifactRefs(
                    event.content.modelProjection,
                    (ref) => rewriteProjectionArtifactRef(ref, references),
                  ),
                }
              : {}),
          }
        : event.content;
  const refs = event.refs
    ? (() => {
        const {
          operationId: _operationId,
          parentOperationId: _parentOperationId,
          traceEventId: _traceEventId,
          ...preserved
        } = event.refs;
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
          ...(event.refs.parentOperationId
            ? {
                parentOperationId: rewriteOwnedId(
                  event.refs.parentOperationId,
                  references.operationIds,
                  'tool operation',
                ),
              }
            : {}),
          ...(event.refs.artifactId
            ? archivedSnapshotResult(event.refs.artifactId, references) !== undefined
              ? {}
              : {
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
    const snapshot = rewriteArchivedSnapshot(content, references);
    if (snapshot) return snapshot;
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
    const snapshot = rewriteArchivedSnapshot(content.value, references);
    if (snapshot) return snapshot;
    return {
      ...content,
      value: rewriteArchivedToolResult(content.value, references),
    };
  }
  if (content.kind === 'subagent') {
    if (linkedChildrenAreSnapshots(references) && content.childSessionId) {
      const { childSessionId: _childSessionId, runId: _runId, ...snapshot } = content;
      return {
        ...snapshot,
        artifactIds: rewriteSnapshotArtifactIds(content.artifactIds, references),
      };
    }
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
        if (linkedChildrenAreSnapshots(references) && item.childSessionId) {
          const {
            childSessionId: _childSessionId,
            runId: _runId,
            resumedFromRunId: _resumedFromRunId,
            ...snapshot
          } = item;
          return {
            ...snapshot,
            artifactIds: rewriteSnapshotArtifactIds(item.artifactIds, references),
          };
        }
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
    const snapshot = rewriteArchivedSnapshot(value, references);
    if (snapshot) return snapshot;
    return rewriteArchivedToolResult(value, references);
  }
  let content: ToolResultContent;
  try {
    content = decodePersistedToolResultContent(markPersisted<ToolResultContent>(value));
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
  if (references.linkedChildren.mode === 'snapshot') return undefined;
  if (references.linkedChildren.mode === 'reject') {
    throw new Error(`Conversation copy cannot retain linked child Session ${childSessionId}`);
  }
  const external = references.linkedChildren.references.get(childSessionId);
  if (!external) {
    throw new Error(`Conversation copy is missing linked child Session ${childSessionId}`);
  }
  return external;
}

function linkedChildrenAreSnapshots(references: ConversationCopyMessageReferenceMap): boolean {
  return references.mode === 'exact' && references.linkedChildren.mode === 'snapshot';
}

function rewriteSnapshotArtifactIds(
  artifactIds: readonly string[],
  references: ConversationCopyMessageReferenceMap,
): readonly string[] {
  if (references.mode !== 'exact' || references.linkedChildren.mode !== 'snapshot') {
    return artifactIds;
  }
  return artifactIds.map((artifactId) =>
    requiredMappedId(references.artifactIds, artifactId, 'linked Artifact'),
  );
}

function rewriteArchivedSnapshot(
  value:
    | ArchivedToolResultPlaceholder
    | Extract<ToolResultContent, { kind: 'archived_tool_result' }>,
  references: ConversationCopyMessageReferenceMap,
): ToolResultContent | undefined {
  const serializedResult = archivedSnapshotResult(value.artifactId, references);
  if (serializedResult === undefined) return undefined;
  const archived = deserializeToolResultArchive(serializedResult);
  if (isArchivedToolResultPlaceholder(archived)) {
    return unavailableArchivedToolResult(value, references);
  }
  try {
    const decoded = decodePersistedToolResultContent(markPersisted<ToolResultContent>(archived));
    return decoded.kind === 'archived_tool_result'
      ? unavailableArchivedToolResult(value, references)
      : rewriteToolResultContent(decoded, references);
  } catch {
    return unavailableArchivedToolResult(value, references);
  }
}

function archivedSnapshotResult(
  artifactId: string | undefined,
  references: ConversationCopyMessageReferenceMap,
): string | undefined {
  if (
    artifactId === undefined ||
    references.mode !== 'exact' ||
    references.linkedChildren.mode !== 'snapshot'
  ) {
    return undefined;
  }
  return references.linkedChildren.archivedResults.get(artifactId);
}

function unavailableArchivedToolResult(
  value:
    | ArchivedToolResultPlaceholder
    | Extract<ToolResultContent, { kind: 'archived_tool_result' }>,
  references: ConversationCopyMessageReferenceMap,
): Extract<ToolResultContent, { kind: 'archived_tool_result' }> {
  return {
    kind: 'archived_tool_result',
    status: 'missing',
    runtimeEventId: rewriteOwnedId(
      value.runtimeEventId,
      references.runtimeEventIds,
      'RuntimeEvent',
    ),
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    originalEstimatedTokens: value.originalEstimatedTokens,
    originalBytes: value.originalBytes,
    rewriteVersion: value.rewriteVersion,
    reason: value.reason,
  };
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
  if (
    (ref.kind !== 'session_file' && ref.kind !== 'session_context') ||
    ref.sessionId !== references.sourceSessionId
  ) {
    return ref;
  }
  if (references.mode === 'preserve_external') return ref;
  if (ref.kind === 'session_context') {
    const refId = references.contextRefs?.get(ref.refId);
    if (!refId) throw new Error(`Conversation copy is missing Session context ${ref.refId}`);
    return {
      ...ref,
      sessionId: references.targetSessionId,
      refId,
    };
  }
  const artifactId = references.artifactIds.get(ref.relativePath);
  if (artifactId) {
    return {
      ...ref,
      sessionId: references.targetSessionId,
      relativePath: artifactId,
    };
  }
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

function rewriteProjectionArtifactRef(
  ref: Extract<StorageRef, { kind: 'session_context' | 'session_file' }>,
  references: ConversationCopyArtifactReferenceMap,
): Extract<StorageRef, { kind: 'session_context' | 'session_file' }> {
  const rewritten = rewriteStorageRef(ref, references);
  if (rewritten.kind !== 'session_context' && rewritten.kind !== 'session_file') {
    throw new Error('Conversation copy produced an invalid projection Artifact reference');
  }
  return rewritten;
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
