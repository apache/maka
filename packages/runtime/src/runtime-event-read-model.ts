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

import type { AgentRunHeader } from '@maka/core/agent-run';
import type { AssistantStepContentKind, StoredMessage, TurnStatus } from '@maka/core/session';
import type { RuntimeEvent, RuntimeEventStatus } from '@maka/core/runtime-event';
import type { ToolActivityKind, ToolResultContent } from '@maka/core/events';
import {
  SANDBOX_BOUNDARY_REQUEST_STATUSES,
  validateSandboxBoundaryExpansion,
} from '@maka/core/sandbox-boundary';

import { TOOL_ACTIVITY_KINDS, normalizeMessageContent } from '@maka/core/events';

import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  isTerminalRuntimeEventStatus,
} from '@maka/core/runtime-event';

import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';

/** The statuses a settled boundary decision can carry — every status but `pending`. */
type SettledSandboxBoundaryStatus = Exclude<
  (typeof SANDBOX_BOUNDARY_REQUEST_STATUSES)[number],
  'pending'
>;
const SETTLED_SANDBOX_BOUNDARY_STATUSES: readonly SettledSandboxBoundaryStatus[] =
  SANDBOX_BOUNDARY_REQUEST_STATUSES.filter(
    (status): status is SettledSandboxBoundaryStatus => status !== 'pending',
  );
import type { CanonicalPermissionOutcomeRecord } from './interaction-authority.js';
import { isArchivedToolResultPlaceholder } from './tool-result-archive.js';

export type RuntimeEventReadModelDiagnosticCode =
  | 'partial_skipped'
  | 'unsupported_event'
  | 'unclaimed_control_fact'
  | 'incomplete_event'
  | 'archived_tool_result_placeholder'
  | 'generated_id'
  | 'tool_use_id_mismatch'
  | 'missing_legacy_message'
  | 'unexpected_projected_message';

/**
 * Whether a diagnostic means the projection may have lost user-visible content.
 *
 * `hard` — a row a reader would have seen may be missing, so the projection is
 * not a faithful view of the session and must not be served in place of one.
 * `soft` — the fact is reported without withholding the view; it does not by
 * itself mean a row is missing.
 *
 * The table is keyed by code so a new diagnostic cannot exist without deciding
 * which side of that line it falls on.
 */
const RUNTIME_EVENT_READ_MODEL_DIAGNOSTIC_SEVERITY: Record<
  RuntimeEventReadModelDiagnosticCode,
  'hard' | 'soft'
> = {
  partial_skipped: 'soft',
  unsupported_event: 'hard',
  unclaimed_control_fact: 'soft',
  incomplete_event: 'hard',
  archived_tool_result_placeholder: 'soft',
  generated_id: 'soft',
  tool_use_id_mismatch: 'hard',
  missing_legacy_message: 'soft',
  unexpected_projected_message: 'soft',
};

export function isHardRuntimeEventReadModelDiagnostic(diagnostic: {
  code: RuntimeEventReadModelDiagnosticCode;
}): boolean {
  return RUNTIME_EVENT_READ_MODEL_DIAGNOSTIC_SEVERITY[diagnostic.code] === 'hard';
}

export function isContinuationStartRuntimeEvent(event: RuntimeEvent): boolean {
  return (
    event.actions?.stateDelta?.continuationStart === true ||
    event.actions?.continuationStart !== undefined
  );
}

/**
 * Whether the event can affect the StoredMessage projection or the state needed
 * to construct one. Pure control-plane facts are intentionally absent so a
 * transcript reader can stream past them without retaining the whole ledger.
 */
export function affectsRuntimeEventStoredMessageProjection(event: RuntimeEvent): boolean {
  return (
    event.content !== undefined ||
    isTerminalRuntimeEvent(event) ||
    event.actions?.permissionRequest !== undefined ||
    event.actions?.permissionDecision !== undefined ||
    event.actions?.permissionAnswerAccepted !== undefined ||
    event.actions?.tokenUsage !== undefined
  );
}

/**
 * Codes that mean the projection did not claim an event, at either severity.
 *
 * Severity decides whether a session still opens; this decides whether the
 * projection has a coverage gap. The projection-coverage contract asserts on
 * this set, so softening an event's severity never softens the contract.
 */
const UNCLAIMED_RUNTIME_EVENT_DIAGNOSTIC_CODES: readonly RuntimeEventReadModelDiagnosticCode[] = [
  'unsupported_event',
  'unclaimed_control_fact',
];

export function isUnclaimedRuntimeEventDiagnostic(diagnostic: {
  code: RuntimeEventReadModelDiagnosticCode;
}): boolean {
  return UNCLAIMED_RUNTIME_EVENT_DIAGNOSTIC_CODES.includes(diagnostic.code);
}

export interface RuntimeEventReadModelDiagnostic {
  code: RuntimeEventReadModelDiagnosticCode;
  eventId?: string;
  runId?: string;
  turnId?: string;
  message: string;
  detail?: unknown;
}

export interface RuntimeEventReadModelProjection {
  messages: StoredMessage[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface ProjectRuntimeEventsToStoredMessagesOptions {
  runHeaders: readonly AgentRunHeader[] | Readonly<Record<string, AgentRunHeader>>;
  canonicalPermissionOutcomes?: ReadonlyMap<string, CanonicalPermissionOutcomeRecord>;
}

export interface ArchivedToolResultReadModelStatus {
  runtimeEventId: string;
  status: Extract<ToolResultContent, { kind: 'archived_tool_result' }>['status'];
}

export interface RuntimeReadModelCompatibilityResult {
  compatible: boolean;
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface RuntimeEventTerminalFact {
  runId: string;
  turnId: string;
  runStatus: 'completed' | 'failed' | 'cancelled';
  turnStatus: 'completed' | 'failed' | 'aborted';
  terminalEvent: RuntimeEvent;
  failureClass?: string;
  abortSource?: string;
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface RuntimeEventTerminalFactResult {
  fact?: RuntimeEventTerminalFact;
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

interface ProjectionState {
  headers: Map<string, AgentRunHeader>;
  diagnostics: RuntimeEventReadModelDiagnostic[];
  toolNameByUseId: Map<string, string>;
  permissionRequestById: Map<
    string,
    {
      requestId: string;
      toolUseId: string;
      toolName: string;
      sessionId: string;
      runId: string;
      turnId: string;
      hint?: string;
    }
  >;
  /**
   * Thinking awaiting its assistant text row, keyed by the step message id
   * (function of the event's providerEventId / storedMessageId — the same id the
   * step's assistant row gets). Per-step turns have several entries per turn, so
   * keying by message id (not turn) attaches each step's reasoning to its own row.
   */
  thinkingByMessageId: Map<string, PendingThinking[]>;
  contentOrderByMessageId: Map<string, AssistantStepContentKind[]>;
}

interface PendingThinking {
  event: RuntimeEvent;
  messageId: string;
  text: string;
  signature?: string;
  providerOptions?: Record<string, unknown>;
}

export function projectRuntimeEventsToStoredMessages(
  events: readonly RuntimeEvent[],
  options: ProjectRuntimeEventsToStoredMessagesOptions,
): RuntimeEventReadModelProjection {
  const state: ProjectionState = {
    headers: normalizeHeaders(options.runHeaders),
    diagnostics: [],
    toolNameByUseId: new Map(),
    permissionRequestById: new Map(),
    thinkingByMessageId: new Map(),
    contentOrderByMessageId: new Map(),
  };
  const messages: StoredMessage[] = [];

  for (const event of events) {
    recordStepContentOrder(event, state);
    if (isPartialRuntimeEvent(event)) {
      diagnostic(state, event, 'partial_skipped', 'partial RuntimeEvent skipped');
      continue;
    }

    let projected = false;
    const content = event.content;
    if (content) {
      switch (content.kind) {
        case 'text':
          projected = projectText(event, state, messages) || projected;
          break;
        case 'function_call':
          projected = projectFunctionCall(event, state, messages) || projected;
          break;
        case 'function_response':
          projected = projectFunctionResponse(event, state, messages) || projected;
          break;
        case 'thinking':
          projected = projectThinking(event, state, messages) || projected;
          break;
        case 'error':
          if (!isTerminalRuntimeEvent(event)) {
            diagnostic(
              state,
              event,
              'unsupported_event',
              'non-terminal error content has no safe legacy read-model row',
            );
          }
          break;
      }
    }

    if (event.actions?.permissionRequest) {
      const request = event.actions.permissionRequest;
      state.permissionRequestById.set(request.requestId, {
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: event.turnId,
        ...(request.hint !== undefined ? { hint: request.hint } : {}),
      });
      state.toolNameByUseId.set(request.toolUseId, request.toolName);
      projected = true;
    }

    if (event.actions?.userQuestionRequest) {
      // The matching function_call/function_response own the legacy rows;
      // this request is live interaction state only.
      projected = true;
    }

    if (event.actions?.userQuestionAnswerAccepted) {
      // InteractionStore owns the canonical answer. This Run-local audit fact
      // intentionally has no legacy chat row.
      projected = true;
    }

    if (event.actions?.permissionAnswerAccepted) {
      projectCanonicalPermissionOutcome(
        event,
        state,
        messages,
        options.canonicalPermissionOutcomes,
      );
      projected = true;
    }

    if (event.actions?.permissionClosureAccepted) {
      // The canonical closure is already represented by this identity-only
      // RuntimeEvent; unlike an answer it has no legacy permission-decision row.
      projected = true;
    }

    if (event.actions?.toolDispatch) {
      // Dispatch is a canonical recovery fact with no legacy chat row. It is
      // consumed by RecoveryResolver, but must remain invisible to messages.
      projected = true;
    }

    if (event.actions?.toolRecovery) {
      // Recovery observations and decisions are canonical audit facts. The
      // matching function_call/function_response own any provider-visible row.
      projected = true;
    }

    if (event.actions?.workspaceFact) {
      // Workspace epoch/version facts belong to the store-owned control-plane
      // stream. They are canonical recovery inputs, never chat messages.
      projected = true;
    }

    if (event.actions?.artifactDelta) {
      // Artifact counters are storage bookkeeping. The tool result that owns the
      // artifact owns its row; this delta has none of its own.
      projected = true;
    }

    if (event.actions?.transferToAgent !== undefined) {
      // A hand-off is control routing. The receiving agent's own events own
      // every provider-visible row the transfer leads to.
      projected = true;
    }

    if (event.actions?.runtimeProtocol) {
      // The protocol marker records which runtime contracts were live from a
      // run's first event. RecoveryResolver reads it; it has no chat row.
      projected = true;
    }

    if (isContinuationStartRuntimeEvent(event)) {
      // Continuation start is a canonical lineage/recovery fact with no
      // legacy chat row. Its following model events own the visible output.
      projected = true;
    }

    if (isSandboxBoundaryStateDelta(event)) {
      // The session sandbox boundary owns enforcement and its own durable
      // revisions. These are canonical control/audit facts, and the tool call
      // and response around them own every provider-visible row.
      projected = true;
    }

    if (isPlanProposalStateDelta(event)) {
      // Plan proposals render from PlanStore as approval cards. This event is
      // still a canonical runtime fact, but intentionally has no legacy chat row.
      projected = true;
    }

    if (event.actions?.permissionDecision) {
      projected = projectPermissionDecision(event, state, messages) || projected;
    }

    if (event.actions?.tokenUsage) {
      projected = projectTokenUsage(event, state, messages) || projected;
    }

    if (isTerminalRuntimeEvent(event)) {
      projected = projectTerminalTurnState(event, state, messages) || projected;
    }

    if (!projected) {
      // Content is the only payload an unclaimed shape could still have owed a
      // row, so its absence is what makes degrading safe here — not a promise
      // that actions never produce rows (permissionDecision, tokenUsage and the
      // terminal fact all do). What holds that up is claim coverage: every
      // action field a reader can meet is claimed above, proven by the
      // projection-coverage contract, so nothing with a row reaches this branch.
      if (event.content === undefined) {
        diagnostic(
          state,
          event,
          'unclaimed_control_fact',
          'control-only RuntimeEvent is not claimed by the legacy read-model projection',
        );
      } else {
        diagnostic(
          state,
          event,
          'unsupported_event',
          'RuntimeEvent shape is not supported by the legacy read-model projection',
        );
      }
    }
  }

  for (const pendingItems of state.thinkingByMessageId.values()) {
    for (const pending of pendingItems) {
      diagnostic(
        state,
        pending.event,
        'unsupported_event',
        'thinking content has no assistant text row with a matching message id',
      );
    }
  }

  return { messages, diagnostics: state.diagnostics };
}

export function projectRuntimeEventsToStoredMessagesWithArchiveStatuses(
  events: readonly RuntimeEvent[],
  options: ProjectRuntimeEventsToStoredMessagesOptions & {
    archiveStatuses:
      | readonly ArchivedToolResultReadModelStatus[]
      | Readonly<Record<string, ArchivedToolResultReadModelStatus['status']>>;
  },
): RuntimeEventReadModelProjection {
  return projectRuntimeEventsToStoredMessages(
    applyArchivedToolResultReadModelStatuses(events, options.archiveStatuses),
    options,
  );
}

export function applyArchivedToolResultReadModelStatuses(
  events: readonly RuntimeEvent[],
  archiveStatuses:
    | readonly ArchivedToolResultReadModelStatus[]
    | Readonly<Record<string, ArchivedToolResultReadModelStatus['status']>>,
): RuntimeEvent[] {
  const statuses = normalizeArchiveStatuses(archiveStatuses);
  if (statuses.size === 0) return [...events];
  return events.map((event) => {
    const status = statuses.get(event.id);
    if (!status || event.content?.kind !== 'function_response') return event;
    if (!isArchivedToolResultPlaceholder(event.content.result)) return event;
    const placeholder = event.content.result;
    return {
      ...event,
      content: {
        ...event.content,
        result: {
          kind: 'archived_tool_result',
          status,
          runtimeEventId: placeholder.runtimeEventId,
          toolCallId: placeholder.toolCallId,
          toolName: placeholder.toolName,
          artifactId: placeholder.artifactId,
          bodySha256: placeholder.bodySha256,
          originalEstimatedTokens: placeholder.originalEstimatedTokens,
          originalBytes: placeholder.originalBytes,
          rewriteVersion: placeholder.rewriteVersion,
          reason: placeholder.reason,
        } satisfies ToolResultContent,
      },
    };
  });
}

export function compareRuntimeReadModelMessages(
  projected: readonly StoredMessage[],
  legacy: readonly StoredMessage[],
): RuntimeReadModelCompatibilityResult {
  const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
  const projectedCounts = countSemanticMessages(projected);
  const legacyCounts = countSemanticMessages(legacy);

  for (const [key, count] of legacyCounts) {
    const projectedCount = projectedCounts.get(key) ?? 0;
    if (projectedCount < count) {
      diagnostics.push({
        code: 'missing_legacy_message',
        message: 'projected RuntimeEvent read model is missing a legacy semantic message',
        detail: JSON.parse(key) as unknown,
      });
    }
  }

  for (const [key, count] of projectedCounts) {
    const legacyCount = legacyCounts.get(key) ?? 0;
    if (legacyCount < count) {
      diagnostics.push({
        code: 'unexpected_projected_message',
        message: 'projected RuntimeEvent read model has no matching legacy semantic message',
        detail: JSON.parse(key) as unknown,
      });
    }
  }

  return { compatible: diagnostics.length === 0, diagnostics };
}

export function classifyRuntimeEventTerminalFact(
  header: AgentRunHeader,
  events: readonly RuntimeEvent[],
): RuntimeEventTerminalFactResult {
  const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
  if (events.length === 0) {
    diagnostics.push(
      readModelDiagnostic('incomplete_event', 'runtime ledger has no readable RuntimeEvents', {
        runId: header.runId,
        turnId: header.turnId,
      }),
    );
    return { diagnostics };
  }

  const terminalSignals = events.filter(
    (event) =>
      !isPartialRuntimeEvent(event) &&
      event.sessionId === header.sessionId &&
      event.runId === header.runId &&
      event.turnId === header.turnId &&
      isTerminalRuntimeEvent(event),
  );

  if (terminalSignals.length === 0) {
    diagnostics.push(
      readModelDiagnostic(
        'incomplete_event',
        'runtime ledger has no matching terminal RuntimeEvent',
        { runId: header.runId, turnId: header.turnId },
      ),
    );
    return { diagnostics };
  }
  if (terminalSignals.length > 1) {
    diagnostics.push(
      readModelDiagnostic(
        'incomplete_event',
        'runtime ledger has multiple matching terminal RuntimeEvents',
        {
          runId: header.runId,
          turnId: header.turnId,
          eventIds: terminalSignals.map((event) => event.id),
        },
      ),
    );
    return { diagnostics };
  }

  const terminalEvent = terminalSignals[0]!;
  if (!isTerminalRuntimeEventStatus(terminalEvent.status)) {
    diagnostics.push(
      readModelDiagnostic(
        'incomplete_event',
        'terminal RuntimeEvent requires a terminal status for recovery',
        terminalEvent,
      ),
    );
    return { diagnostics };
  }

  if (terminalEvent.status === 'completed') {
    const fact: RuntimeEventTerminalFact = {
      runId: header.runId,
      turnId: header.turnId,
      runStatus: 'completed',
      turnStatus: 'completed',
      terminalEvent,
      diagnostics,
    };
    return { fact, diagnostics };
  }

  if (terminalEvent.status === 'failed') {
    const failureClass = failureClassFromRuntimeEvent(terminalEvent, header);
    if (!failureClass) {
      diagnostics.push(
        readModelDiagnostic(
          'incomplete_event',
          'failed terminal RuntimeEvent requires a stable failure class',
          terminalEvent,
        ),
      );
      return { diagnostics };
    }
    const fact: RuntimeEventTerminalFact = {
      runId: header.runId,
      turnId: header.turnId,
      runStatus: 'failed',
      turnStatus: 'failed',
      terminalEvent,
      failureClass,
      diagnostics,
    };
    return { fact, diagnostics };
  }

  const abortSource = abortSourceFromRuntime(terminalEvent, header);
  if (!abortSource) {
    diagnostics.push(
      readModelDiagnostic(
        'incomplete_event',
        'aborted terminal RuntimeEvent requires an abort source',
        terminalEvent,
      ),
    );
    return { diagnostics };
  }
  const fact: RuntimeEventTerminalFact = {
    runId: header.runId,
    turnId: header.turnId,
    runStatus: 'cancelled',
    turnStatus: 'aborted',
    terminalEvent,
    abortSource,
    diagnostics,
  };
  return { fact, diagnostics };
}

function projectText(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'text') return false;
  if (event.role === 'user') {
    const message = projectRuntimeEventUserMessage(event, stableMessageId(event, state, 'user'));
    if (!message) return false;
    messages.push(message);
    return true;
  }

  if (event.role === 'model') {
    const header = state.headers.get(event.runId);
    if (!header?.modelId) {
      diagnostic(
        state,
        event,
        'incomplete_event',
        'model text RuntimeEvent requires AgentRunHeader.modelId',
      );
      return false;
    }
    const assistantId = stableMessageId(event, state, 'assistant');
    const contentOrder = nonCanonicalContentOrder(state.contentOrderByMessageId.get(assistantId));
    messages.push({
      type: 'assistant',
      id: assistantId,
      turnId: event.turnId,
      ts: event.ts,
      text: event.content.text,
      ...(event.content.providerOptions !== undefined
        ? { providerOptions: structuredClone(event.content.providerOptions) }
        : {}),
      ...(contentOrder ? { contentOrder } : {}),
      modelId: header.modelId,
    });
    attachPendingThinking(event, state, messages, assistantId);
    return true;
  }

  diagnostic(
    state,
    event,
    'unsupported_event',
    `text content with role ${event.role} is not projected`,
  );
  return false;
}

export function projectRuntimeEventUserMessage(
  event: RuntimeEvent,
  messageId: string,
): Extract<StoredMessage, { type: 'user' }> | undefined {
  if (event.role !== 'user' || event.content?.kind !== 'text') return undefined;
  return {
    type: 'user',
    id: messageId,
    turnId: event.turnId,
    ts: event.ts,
    ...normalizeMessageContent(event.content),
    ...(event.content.origin !== undefined ? { origin: event.content.origin } : {}),
    ...(event.content.steering === true ? { steeringEventId: event.id } : {}),
  };
}

function nonCanonicalContentOrder(
  order: readonly AssistantStepContentKind[] | undefined,
): AssistantStepContentKind[] | undefined {
  if (!order?.length) return undefined;
  const present = new Set(order);
  const canonical = (['thinking', 'text', 'tools'] as const).filter((kind) => present.has(kind));
  return order.every((kind, index) => kind === canonical[index]) ? undefined : [...order];
}

function recordStepContentOrder(event: RuntimeEvent, state: ProjectionState): void {
  const content = event.content;
  let messageId: string | undefined;
  let kind: AssistantStepContentKind | undefined;
  if (event.role === 'model' && content?.kind === 'text') {
    messageId = event.refs?.providerEventId ?? event.refs?.storedMessageId ?? event.id;
    kind = 'text';
  } else if (event.role === 'model' && content?.kind === 'thinking') {
    messageId = event.refs?.providerEventId ?? event.refs?.storedMessageId ?? event.id;
    kind = 'thinking';
  } else if (event.role === 'model' && content?.kind === 'function_call' && event.refs?.stepId) {
    messageId = event.refs.stepId;
    kind = 'tools';
  }
  if (!messageId || !kind) return;
  const order = state.contentOrderByMessageId.get(messageId) ?? [];
  if (!order.includes(kind)) state.contentOrderByMessageId.set(messageId, [...order, kind]);
}

function normalizeArchiveStatuses(
  archiveStatuses:
    | readonly ArchivedToolResultReadModelStatus[]
    | Readonly<Record<string, ArchivedToolResultReadModelStatus['status']>>,
): Map<string, ArchivedToolResultReadModelStatus['status']> {
  const map = new Map<string, ArchivedToolResultReadModelStatus['status']>();
  if (Array.isArray(archiveStatuses)) {
    for (const item of archiveStatuses) {
      map.set(item.runtimeEventId, item.status);
    }
    return map;
  }
  for (const [runtimeEventId, status] of Object.entries(archiveStatuses)) {
    map.set(runtimeEventId, status);
  }
  return map;
}

function projectThinking(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'thinking') return false;
  const messageId = thinkingMessageId(event);
  const pending: PendingThinking = {
    event,
    messageId,
    text: event.content.text,
    ...(event.content.signature !== undefined ? { signature: event.content.signature } : {}),
    ...(event.content.providerOptions !== undefined
      ? { providerOptions: structuredClone(event.content.providerOptions) }
      : {}),
  };
  // The step's assistant text row lands after its thinking in ledger order, so
  // attach eagerly if it already exists (older ordering), else park by message id
  // for projectText's attachPendingThinking to claim.
  if (attachThinkingToAssistant(event, pending, messages)) return true;
  const pendingItems = state.thinkingByMessageId.get(messageId) ?? [];
  pendingItems.push(pending);
  state.thinkingByMessageId.set(messageId, pendingItems);
  return true;
}

function projectFunctionCall(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'function_call') return false;
  const toolUseId = toolUseIdFor(event);
  if (!toolUseId) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'function_call RuntimeEvent requires content.id or refs.toolCallId',
    );
    return false;
  }
  if (event.content.id !== toolUseId) {
    diagnostic(
      state,
      event,
      'tool_use_id_mismatch',
      'function_call content.id differs from refs.toolCallId',
      {
        contentId: event.content.id,
        refToolCallId: event.refs?.toolCallId,
      },
    );
  }
  state.toolNameByUseId.set(toolUseId, event.content.name);
  messages.push({
    type: 'tool_call',
    id: toolUseId,
    turnId: event.turnId,
    ts: event.ts,
    toolName: event.content.name,
    ...(toolActivityKindStateDelta(event) !== undefined
      ? { activityKind: toolActivityKindStateDelta(event) }
      : {}),
    ...(stringStateDelta(event, 'displayName') !== undefined
      ? { displayName: stringStateDelta(event, 'displayName') }
      : {}),
    ...(stringStateDelta(event, 'intent') !== undefined
      ? { intent: stringStateDelta(event, 'intent') }
      : {}),
    // Carry the step pairing through the projection: without it, sessions
    // rebuilt from the runtime event log lose the tool↔step association and
    // the UI timeline falls back to legacy tools-before-text ordering.
    ...(event.refs?.stepId ? { stepId: event.refs.stepId } : {}),
    ...toolActivityIdentity(event),
    args: event.content.args,
    ...(event.content.providerOptions !== undefined
      ? { providerOptions: structuredClone(event.content.providerOptions) }
      : {}),
    ...(event.content.providerExecuted !== undefined
      ? { providerExecuted: event.content.providerExecuted }
      : {}),
  });
  return true;
}

function projectFunctionResponse(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'function_response') return false;
  const toolUseId = toolUseIdFor(event);
  if (!toolUseId) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'function_response RuntimeEvent requires content.id or refs.toolCallId',
    );
    return false;
  }
  if (event.content.id !== toolUseId) {
    diagnostic(
      state,
      event,
      'tool_use_id_mismatch',
      'function_response content.id differs from refs.toolCallId',
      {
        contentId: event.content.id,
        refToolCallId: event.refs?.toolCallId,
      },
    );
  }
  const legacyPlanResult = isLegacyPlanToolResult(event.content.result)
    ? { kind: 'json' as const, value: event.content.result }
    : undefined;
  const compatibleResult = legacyPlanResult ?? event.content.result;
  const archivedPlaceholder = isArchivedToolResultPlaceholder(compatibleResult)
    ? compatibleResult
    : undefined;
  let normalizedResult: ToolResultContent | undefined;
  if (!archivedPlaceholder) {
    try {
      normalizedResult = decodeCanonicalToolResultContent(compatibleResult);
    } catch (error) {
      diagnostic(
        state,
        event,
        'incomplete_event',
        error instanceof Error && error.message === 'Invalid shell tool result content'
          ? 'function_response contains an invalid shell tool result'
          : 'function_response result is not a supported ToolResultContent',
      );
      return false;
    }
  }
  if (archivedPlaceholder) {
    diagnostic(
      state,
      event,
      'archived_tool_result_placeholder',
      'function_response result is archived and not loaded in read model',
      {
        artifactId: archivedPlaceholder.artifactId,
        runtimeEventId: archivedPlaceholder.runtimeEventId,
        toolCallId: archivedPlaceholder.toolCallId,
        toolName: archivedPlaceholder.toolName,
        reason: archivedPlaceholder.reason,
        rewriteVersion: archivedPlaceholder.rewriteVersion,
      },
    );
  }
  if (event.content.name) state.toolNameByUseId.set(toolUseId, event.content.name);
  const resultContent: ToolResultContent = archivedPlaceholder
    ? {
        kind: 'archived_tool_result',
        status: 'not_loaded',
        runtimeEventId: archivedPlaceholder.runtimeEventId,
        toolCallId: archivedPlaceholder.toolCallId,
        toolName: archivedPlaceholder.toolName,
        artifactId: archivedPlaceholder.artifactId,
        bodySha256: archivedPlaceholder.bodySha256,
        originalEstimatedTokens: archivedPlaceholder.originalEstimatedTokens,
        originalBytes: archivedPlaceholder.originalBytes,
        rewriteVersion: archivedPlaceholder.rewriteVersion,
        reason: archivedPlaceholder.reason,
      }
    : normalizedResult!;
  messages.push({
    type: 'tool_result',
    id: stableMessageId(event, state, 'tool_result'),
    turnId: event.turnId,
    ts: event.ts,
    toolUseId,
    isError: event.content.isError === true,
    content: resultContent,
    ...(event.content.providerExecuted !== undefined
      ? { providerExecuted: event.content.providerExecuted }
      : {}),
    ...(event.content.providerExecuted && event.content.providerOutput !== undefined
      ? { providerOutput: structuredClone(event.content.providerOutput) }
      : {}),
    ...(numberStateDelta(event, 'durationMs') !== undefined
      ? { durationMs: numberStateDelta(event, 'durationMs') }
      : {}),
    ...toolActivityIdentity(event),
  });
  return true;
}

function toolActivityIdentity(event: RuntimeEvent): {
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
} {
  return {
    ...(event.origin !== undefined ? { origin: event.origin } : {}),
    ...(event.modelVisibility !== undefined ? { modelVisibility: event.modelVisibility } : {}),
    ...(event.refs?.parentToolCallId !== undefined
      ? { parentToolCallId: event.refs.parentToolCallId }
      : {}),
    ...(event.refs?.parentOperationId !== undefined
      ? { parentOperationId: event.refs.parentOperationId }
      : {}),
  };
}

function projectPermissionDecision(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const decision = event.actions?.permissionDecision;
  if (!decision) return false;
  const request = state.permissionRequestById.get(decision.requestId);
  const toolUseId = event.refs?.toolCallId ?? request?.toolUseId;
  if (!toolUseId) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'permission decision requires refs.toolCallId or a paired permission request',
    );
    return false;
  }
  if (request && request.toolUseId !== toolUseId) {
    diagnostic(
      state,
      event,
      'tool_use_id_mismatch',
      'permission decision toolUseId does not match its paired permission request',
    );
    return false;
  }
  const toolStateName = state.toolNameByUseId.get(toolUseId);
  const toolName = decision.toolName ?? request?.toolName ?? toolStateName;
  if (!toolName) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'permission decision requires durable toolName or a paired permission request or tool call',
    );
    return false;
  }
  if (
    (request?.toolName !== undefined && request.toolName !== toolName) ||
    (toolStateName !== undefined && toolStateName !== toolName)
  ) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'permission decision toolName does not match its paired request or tool call',
    );
    return false;
  }
  messages.push({
    type: 'permission_decision',
    id: decision.requestId,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId,
    toolName,
    decision: decision.decision,
    ...(decision.rememberForTurn !== undefined
      ? { rememberForTurn: decision.rememberForTurn }
      : {}),
    ...(decision.reviewer !== undefined ? { reviewer: decision.reviewer } : {}),
    ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
    ...(decision.riskLevel !== undefined ? { riskLevel: decision.riskLevel } : {}),
    ...(request?.hint !== undefined ? { hint: request.hint } : {}),
  });
  return true;
}

function projectCanonicalPermissionOutcome(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
  outcomes: ReadonlyMap<string, CanonicalPermissionOutcomeRecord> | undefined,
): void {
  const accepted = event.actions?.permissionAnswerAccepted;
  if (!accepted) return;
  const ledgerRequest = state.permissionRequestById.get(accepted.requestId);
  const canonical = outcomes?.get(accepted.requestId);
  const toolUseId = event.refs?.toolCallId;
  if (!canonical || !toolUseId) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'permission answer acceptance requires a canonical Interaction outcome',
      { requestId: accepted.requestId },
    );
    return;
  }
  const outcome = canonical.outcome;
  if (
    canonical.sessionId !== event.sessionId ||
    canonical.runId !== event.runId ||
    canonical.turnId !== event.turnId ||
    canonical.requestId !== accepted.requestId ||
    canonical.request.toolUseId !== toolUseId ||
    (ledgerRequest !== undefined &&
      (ledgerRequest.sessionId !== event.sessionId ||
        ledgerRequest.runId !== event.runId ||
        ledgerRequest.turnId !== event.turnId ||
        ledgerRequest.toolUseId !== toolUseId ||
        ledgerRequest.toolName !== canonical.request.prompt.toolName))
  ) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'permission answer canonical outcome identity does not match its acceptance',
      { requestId: accepted.requestId },
    );
    return;
  }
  messages.push({
    type: 'permission_decision',
    id: accepted.requestId,
    turnId: event.turnId,
    ts: outcome.committedAt,
    toolUseId,
    toolName: canonical.request.prompt.toolName,
    decision: outcome.decision,
    rememberForTurn: outcome.rememberForTurn,
    reviewer: outcome.reviewer,
    ...(outcome.rationale !== undefined ? { rationale: outcome.rationale } : {}),
    ...(outcome.riskLevel !== undefined ? { riskLevel: outcome.riskLevel } : {}),
    ...(ledgerRequest?.hint !== undefined ? { hint: ledgerRequest.hint } : {}),
  });
}

function projectTokenUsage(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const usage = event.actions?.tokenUsage;
  if (!usage) return false;
  messages.push({
    type: 'token_usage',
    id: stableMessageId(event, state, 'token_usage'),
    turnId: event.turnId,
    ts: event.ts,
    input: usage.input,
    output: usage.output,
    ...(usage.cacheHitInput !== undefined ? { cacheHitInput: usage.cacheHitInput } : {}),
    ...(usage.cacheMissInput !== undefined ? { cacheMissInput: usage.cacheMissInput } : {}),
    ...(usage.cacheMissInputSource !== undefined
      ? { cacheMissInputSource: usage.cacheMissInputSource }
      : {}),
    ...(usage.cacheWriteInput !== undefined ? { cacheWriteInput: usage.cacheWriteInput } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.total !== undefined ? { total: usage.total } : {}),
    ...(usage.rawFinishReason !== undefined ? { rawFinishReason: usage.rawFinishReason } : {}),
    ...(usage.runtimeSteps !== undefined ? { runtimeSteps: usage.runtimeSteps } : {}),
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheCreation !== undefined ? { cacheCreation: usage.cacheCreation } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.systemPromptHash !== undefined ? { systemPromptHash: usage.systemPromptHash } : {}),
    ...(usage.contextRemaining !== undefined ? { contextRemaining: usage.contextRemaining } : {}),
    ...(usage.prefixHash !== undefined ? { prefixHash: usage.prefixHash } : {}),
    ...(usage.prefixChangeReason !== undefined
      ? { prefixChangeReason: usage.prefixChangeReason }
      : {}),
    ...(usage.requestShapeHash !== undefined ? { requestShapeHash: usage.requestShapeHash } : {}),
    ...(usage.requestShapeChangeReason !== undefined
      ? { requestShapeChangeReason: usage.requestShapeChangeReason }
      : {}),
    ...(usage.promptSegments !== undefined ? { promptSegments: usage.promptSegments } : {}),
    ...(usage.contextBudget !== undefined ? { contextBudget: usage.contextBudget } : {}),
    ...(event.refs?.providerRequestTraceId !== undefined
      ? { providerRequestTraceId: event.refs.providerRequestTraceId }
      : {}),
  });
  return true;
}

function projectTerminalTurnState(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const header = state.headers.get(event.runId);
  if (!header) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'terminal RuntimeEvent requires an AgentRunHeader',
    );
    return false;
  }
  const status = turnStatusFor(event.status, header.status);
  if (!status) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'terminal RuntimeEvent status cannot be mapped to a legacy TurnStatus',
    );
    return false;
  }
  const abortSource = status === 'aborted' ? abortSourceFromRuntime(event, header) : undefined;
  const failureClass =
    status === 'failed' ? failureClassFromRuntimeEvent(event, header) : undefined;
  const partialOutputRetained = messages.some(
    (message) =>
      message.turnId === event.turnId &&
      ((message.type === 'assistant' && message.text.trim().length > 0) ||
        message.type === 'tool_result'),
  );
  messages.push({
    type: 'turn_state',
    id: stableMessageId(event, state, 'turn_state'),
    turnId: event.turnId,
    ts: event.ts,
    status,
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(status === 'aborted' ? { abortedAt: event.ts } : {}),
    ...(abortSource ? { abortSource } : {}),
    ...(status === 'failed' ? { errorClass: failureClass ?? 'unknown' } : {}),
    partialOutputRetained,
  });
  if (failureClass === 'tool_step_cap_reached') {
    messages.push({
      type: 'system_note',
      id: `${event.id}:step-limit-notice`,
      turnId: event.turnId,
      ts: event.ts,
      kind: 'step_limit',
    });
  }
  if (status === 'failed' && !failureClass) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'failed terminal event did not carry an exact AgentRunHeader.failureClass',
    );
  }
  if (status === 'aborted' && !abortSource) {
    diagnostic(
      state,
      event,
      'incomplete_event',
      'abortSource is not present in RuntimeEvent or AgentRunHeader metadata',
    );
  }
  return true;
}

function attachPendingThinking(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
  assistantMessageId: string,
): void {
  const pendingItems = state.thinkingByMessageId.get(assistantMessageId);
  if (!pendingItems) return;
  if (pendingItems.every((pending) => attachThinkingToAssistant(event, pending, messages))) {
    state.thinkingByMessageId.delete(assistantMessageId);
  }
}

function attachThinkingToAssistant(
  event: RuntimeEvent,
  pending: PendingThinking,
  messages: StoredMessage[],
): boolean {
  // Attach to the assistant row whose id equals the thinking's step message id
  // (per-step pairing). Scans from the tail so the newest matching row wins.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== 'assistant' || message.turnId !== event.turnId) continue;
    if (message.id !== pending.messageId) continue;
    const incoming = {
      text: pending.text,
      ...(pending.signature !== undefined ? { signature: pending.signature } : {}),
      ...(pending.providerOptions !== undefined
        ? { providerOptions: structuredClone(pending.providerOptions) }
        : {}),
    };
    if (!message.thinking) {
      message.thinking = incoming;
      return true;
    }
    const parts = message.thinking.parts ?? [
      {
        text: message.thinking.text,
        ...(message.thinking.signature !== undefined
          ? { signature: message.thinking.signature }
          : {}),
        ...(message.thinking.providerOptions !== undefined
          ? { providerOptions: structuredClone(message.thinking.providerOptions) }
          : {}),
      },
    ];
    message.thinking = {
      text: message.thinking.text + pending.text,
      parts: [...parts, incoming],
    };
    return true;
  }
  return false;
}

function thinkingMessageId(event: RuntimeEvent): string {
  return event.refs?.providerEventId ?? event.refs?.storedMessageId ?? event.id;
}

function abortSourceFromRuntime(event: RuntimeEvent, header: AgentRunHeader): string | undefined {
  return (
    stringStateDelta(event, 'abortSource') ??
    stringStateDelta(event, 'source') ??
    stringRecordValue(event.refs, 'abortSource') ??
    stringRecordValue(event.refs, 'source') ??
    stringRecordValue(header as unknown as Record<string, unknown>, 'abortSource')
  );
}

function failureClassFromRuntimeEvent(
  event: RuntimeEvent,
  header: AgentRunHeader,
): string | undefined {
  return (
    stringStateDelta(event, 'failureClass') ??
    stringStateDelta(event, 'errorClass') ??
    stringStateDelta(event, 'reason') ??
    stringStateDelta(event, 'code') ??
    (event.content?.kind === 'error' ? nonEmptyString(event.content.reason) : undefined) ??
    (event.content?.kind === 'error' ? nonEmptyString(event.content.code) : undefined) ??
    header.failureClass
  );
}

function stringRecordValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stableMessageId(
  event: RuntimeEvent,
  state: ProjectionState,
  kind: StoredMessage['type'],
  contentId?: string,
): string {
  const stable =
    event.refs?.storedMessageId ?? event.refs?.providerEventId ?? contentId ?? event.id;
  if (stable) return stable;
  const generated = `rtproj:${event.id}:${kind}`;
  diagnostic(state, event, 'generated_id', 'projection used a deterministic generated id', {
    id: generated,
  });
  return generated;
}

function toolUseIdFor(event: RuntimeEvent): string | undefined {
  if (event.content?.kind !== 'function_call' && event.content?.kind !== 'function_response') {
    return event.refs?.toolCallId;
  }
  return event.content.id || event.refs?.toolCallId;
}

function normalizeHeaders(
  headers: readonly AgentRunHeader[] | Readonly<Record<string, AgentRunHeader>>,
): Map<string, AgentRunHeader> {
  if (Array.isArray(headers)) {
    return new Map(headers.map((header) => [header.runId, header]));
  }
  return new Map(Object.values(headers).map((header) => [header.runId, header]));
}

function turnStatusFor(
  eventStatus: RuntimeEventStatus | undefined,
  runStatus: AgentRunHeader['status'],
): TurnStatus | undefined {
  if (eventStatus === 'completed') return 'completed';
  if (eventStatus === 'failed') return 'failed';
  if (eventStatus === 'aborted' || eventStatus === 'cancelled') return 'aborted';
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'failed') return 'failed';
  if (runStatus === 'cancelled') return 'aborted';
  return undefined;
}

function stringStateDelta(event: RuntimeEvent, key: string): string | undefined {
  const value = event.actions?.stateDelta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function toolActivityKindStateDelta(event: RuntimeEvent): ToolActivityKind | undefined {
  const value = stringStateDelta(event, 'activityKind');
  return TOOL_ACTIVITY_KINDS.find((kind) => kind === value);
}

function numberStateDelta(event: RuntimeEvent, key: string): number | undefined {
  const value = event.actions?.stateDelta?.[key];
  return typeof value === 'number' ? value : undefined;
}

function isLegacyPlanToolResult(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === 'plan_submitted' ||
    kind === 'plan_progress_updated' ||
    kind === 'plan_execution_completed' ||
    kind === 'plan_execution_cancelled'
  );
}

function isPlanProposalStateDelta(event: RuntimeEvent): boolean {
  const stateDelta = event.actions?.stateDelta;
  return (
    event.role === 'system' &&
    event.author === 'agent' &&
    typeof stateDelta?.planId === 'string' &&
    typeof stateDelta.title === 'string'
  );
}

/**
 * A boundary fact is canonical only in the exact shape AiSdkFlow emits: every
 * field of the source SessionEvent, the identity it maps to, and the tool call
 * it settles. A partial match is worse than none — it would claim a corrupt
 * ledger as sound while still paying the cost of rejecting a malformed one.
 */
function isSandboxBoundaryStateDelta(event: RuntimeEvent): boolean {
  const stateDelta = event.actions?.stateDelta;
  if (!stateDelta) return false;
  const request = stateDelta.sandboxBoundaryRequest;
  const decision = stateDelta.sandboxBoundaryDecision;
  if (request === undefined && decision === undefined) return false;
  if (event.role !== 'system' || typeof event.refs?.toolCallId !== 'string') return false;
  if (request !== undefined) {
    return (
      event.author === 'system' &&
      isRecord(request) &&
      typeof request.requestId === 'string' &&
      typeof request.toolUseId === 'string' &&
      typeof request.justification === 'string' &&
      validateSandboxBoundaryExpansion(request.expansion).ok
    );
  }
  return (
    event.author === 'user' &&
    isRecord(decision) &&
    typeof decision.requestId === 'string' &&
    (decision.decision === 'allow' || decision.decision === 'deny') &&
    SETTLED_SANDBOX_BOUNDARY_STATUSES.includes(decision.status as SettledSandboxBoundaryStatus) &&
    typeof decision.revision === 'number' &&
    Number.isFinite(decision.revision)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(
  state: ProjectionState,
  event: RuntimeEvent,
  code: RuntimeEventReadModelDiagnosticCode,
  message: string,
  detail?: unknown,
): void {
  state.diagnostics.push({
    code,
    eventId: event.id,
    runId: event.runId,
    turnId: event.turnId,
    message,
    ...(detail !== undefined ? { detail } : {}),
  });
}

function readModelDiagnostic(
  code: RuntimeEventReadModelDiagnosticCode,
  message: string,
  detail: RuntimeEvent | { runId: string; turnId: string; [key: string]: unknown },
): RuntimeEventReadModelDiagnostic {
  if (isRuntimeEventDiagnosticDetail(detail)) {
    return {
      code,
      eventId: detail.id,
      runId: detail.runId,
      turnId: detail.turnId,
      message,
    };
  }
  return {
    code,
    runId: detail.runId,
    turnId: detail.turnId,
    message,
    detail,
  };
}

function isRuntimeEventDiagnosticDetail(
  detail: RuntimeEvent | { runId: string; turnId: string; [key: string]: unknown },
): detail is RuntimeEvent {
  return (
    typeof (detail as RuntimeEvent).id === 'string' &&
    typeof (detail as RuntimeEvent).sessionId === 'string' &&
    typeof detail.runId === 'string' &&
    typeof detail.turnId === 'string'
  );
}

function countSemanticMessages(messages: readonly StoredMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = stableSemanticKey(semanticMessage(message));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function stableSemanticKey(value: unknown): string {
  return JSON.stringify(sortSemanticValue(value));
}

function sortSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSemanticValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortSemanticValue((value as Record<string, unknown>)[key])]),
  );
}

function semanticMessage(message: StoredMessage): unknown {
  switch (message.type) {
    case 'user':
      return {
        type: message.type,
        turnId: message.turnId,
        text: message.text,
        displayText: message.displayText,
        origin: message.origin,
        attachments: message.attachments ?? [],
        quotes: message.quotes ?? [],
      };
    case 'assistant':
      return {
        type: message.type,
        turnId: message.turnId,
        text: message.text,
        modelId: message.modelId,
        thinking: message.thinking,
      };
    case 'tool_call':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.id,
        toolName: message.toolName,
        activityKind: message.activityKind,
        displayName: message.displayName,
        intent: message.intent,
        args: message.args,
      };
    case 'tool_result':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.toolUseId,
        isError: message.isError,
        content: message.content,
        durationMs: message.durationMs,
      };
    case 'permission_decision':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.toolUseId,
        toolName: message.toolName,
        decision: message.decision,
        rememberForTurn: message.rememberForTurn,
        hint: message.hint,
      };
    case 'token_usage':
      return {
        type: message.type,
        turnId: message.turnId,
        input: message.input,
        output: message.output,
        cacheHitInput: message.cacheHitInput,
        cacheMissInput: message.cacheMissInput,
        cacheMissInputSource: message.cacheMissInputSource,
        cacheWriteInput: message.cacheWriteInput,
        reasoning: message.reasoning,
        total: message.total,
        rawFinishReason: message.rawFinishReason,
        runtimeSteps: message.runtimeSteps,
        cacheRead: message.cacheRead,
        cacheCreation: message.cacheCreation,
        costUsd: message.costUsd,
        systemPromptHash: message.systemPromptHash,
        contextRemaining: message.contextRemaining,
        prefixHash: message.prefixHash,
        prefixChangeReason: message.prefixChangeReason,
        requestShapeHash: message.requestShapeHash,
        requestShapeChangeReason: message.requestShapeChangeReason,
        promptSegments: message.promptSegments,
        contextBudget: message.contextBudget,
        providerRequestTraceId: message.providerRequestTraceId,
      };
    case 'turn_state':
      return {
        type: message.type,
        turnId: message.turnId,
        status: message.status,
        parentTurnId: message.parentTurnId,
        retriedFromTurnId: message.retriedFromTurnId,
        regeneratedFromTurnId: message.regeneratedFromTurnId,
        branchOfTurnId: message.branchOfTurnId,
        parentSessionId: message.parentSessionId,
        abortedAt: message.abortedAt,
        abortSource: message.abortSource,
        errorClass: message.errorClass,
        partialOutputRetained: message.partialOutputRetained,
      };
    case 'system_note':
      return {
        type: message.type,
        turnId: message.turnId,
        kind: message.kind,
        data: message.data,
      };
  }
}
