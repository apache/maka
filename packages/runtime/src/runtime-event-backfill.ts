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

import type { RuntimeInvocationOutcome } from '@maka/core/runtime-invocation';
import type { RunIdentity } from './terminal-run-commit.js';
import { isRuntimeSystemNoteKind } from '@maka/core/session';
import type {
  PermissionDecisionMessage,
  StoredMessage,
  TokenUsageMessage,
  ToolCallMessage,
  ToolResultMessage,
  TurnStateMessage,
} from '@maka/core/session';
import type { RuntimeEvent, RuntimeEventStatus } from '@maka/core/runtime-event';
import { createRuntimeEventId } from '@maka/core/runtime-event';

export const RUNTIME_EVENT_BACKFILL_STATE_KEY = 'makaRuntimeRecovery';

export type RuntimeEventBackfillDiagnosticCode =
  | 'skipped_high_risk_message'
  | 'skipped_provider_native_replay_gap'
  | 'skipped_unmatched_tool_result'
  | 'synthesized_terminal_event';

export interface RuntimeEventBackfillDiagnostic {
  code: RuntimeEventBackfillDiagnosticCode;
  message: string;
  detail?: unknown;
}

/**
 * How the imported turn ended, as the importer read it off the transcript.
 *
 * Without one there is no terminal RuntimeEvent to write: nothing else in a
 * StoredMessage transcript states an outcome the ledger can be held to.
 */
export interface RuntimeEventBackfillOutcome {
  status: RuntimeInvocationOutcome;
  ts: number;
  failureClass?: string;
  abortSource?: string;
}

export interface RuntimeEventBackfillInput {
  run: RunIdentity & { invocationId?: string };
  outcome?: RuntimeEventBackfillOutcome;
  messages: readonly StoredMessage[];
  invocationId?: string;
  modelHistory?: 'full' | 'conversation_text';
  now?: () => number;
  newId?: () => string;
}

export interface RuntimeEventBackfillResult {
  events: RuntimeEvent[];
  diagnostics: RuntimeEventBackfillDiagnostic[];
}

interface RuntimeEventBackfillRecoveryState {
  kind: 'runtime_event_backfill';
  source: 'legacy_stored_message';
  reason: 'missing_runtime_event_ledger';
  sourceMessageId?: string;
  sourceMessageType?: StoredMessage['type'];
  confidence: 'lossless';
  generatedAt: number;
  version: 1;
}

export function backfillRuntimeEventsFromStoredMessages(
  input: RuntimeEventBackfillInput,
): RuntimeEventBackfillResult {
  const newId = input.newId ?? (() => createRuntimeEventId('rt-backfill'));
  const now = input.now ?? (() => Date.now());
  const invocationId =
    input.run.invocationId ?? input.invocationId ?? `backfill-${input.run.runId}`;
  const diagnostics: RuntimeEventBackfillDiagnostic[] = [];
  const events: RuntimeEvent[] = [];
  const conversationTextOnly = input.modelHistory === 'conversation_text';
  const turnMessages = input.messages
    .filter((message) => messageTurnId(message) === input.run.turnId)
    .slice()
    .sort((a, b) => a.ts - b.ts);
  const toolCalls = new Map<string, ToolCallMessage>();
  const replayableProviderToolUseIds = new Set(
    turnMessages
      .filter(
        (message): message is ToolResultMessage =>
          message.type === 'tool_result' &&
          message.providerExecuted === true &&
          message.providerOutput !== undefined,
      )
      .map((message) => message.toolUseId),
  );

  for (const message of turnMessages) {
    if (message.type === 'tool_call') {
      toolCalls.set(message.id, message);
    }
  }

  for (const message of turnMessages) {
    const base = {
      invocationId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      turnId: input.run.turnId,
      ts: message.ts,
      partial: false,
    } as const;

    switch (message.type) {
      case 'user':
        events.push({
          ...base,
          id: newId(),
          role: 'user',
          author: message.origin ? 'host' : 'user',
          content: {
            kind: 'text',
            text: message.text,
            ...(message.displayText !== undefined ? { displayText: message.displayText } : {}),
            ...(message.origin !== undefined ? { origin: message.origin } : {}),
            ...(message.attachments !== undefined && message.attachments.length > 0
              ? { attachments: message.attachments }
              : {}),
            ...(message.quotes !== undefined && message.quotes.length > 0
              ? { quotes: message.quotes }
              : {}),
            ...(message.directoryReferences
              ? { directoryReferences: message.directoryReferences }
              : {}),
            ...(message.inlineReferences !== undefined
              ? { inlineReferences: message.inlineReferences }
              : {}),
          },
          actions: { stateDelta: recoveryState(now, message) },
          refs: { storedMessageId: message.id },
        });
        break;

      case 'assistant':
        if (!conversationTextOnly || message.text.length > 0) {
          events.push({
            ...base,
            id: newId(),
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: message.text },
            actions: { stateDelta: recoveryState(now, message) },
            refs: { storedMessageId: message.id },
          });
        }
        if (!conversationTextOnly && message.thinking) {
          const parts = message.thinking.parts ?? [message.thinking];
          for (const part of parts) {
            events.push({
              ...base,
              id: newId(),
              role: 'model',
              author: 'agent',
              content: {
                kind: 'thinking',
                text: part.text,
                ...(part.signature !== undefined ? { signature: part.signature } : {}),
                ...(part.providerOptions !== undefined
                  ? { providerOptions: structuredClone(part.providerOptions) }
                  : {}),
              },
              actions: { stateDelta: recoveryState(now, message) },
              refs: { storedMessageId: message.id },
            });
          }
        }
        break;

      case 'tool_call': {
        if (conversationTextOnly) break;
        // A provider-native call whose opaque output was not retained can never
        // be replayed to a provider again, so it is converted hidden: the
        // transcript keeps the card, and no model request is built from it.
        const unreplayable =
          message.providerExecuted === true && !replayableProviderToolUseIds.has(message.id);
        if (unreplayable) {
          diagnostics.push({
            code: 'skipped_provider_native_replay_gap',
            message:
              'provider-native tool history requires the opaque provider output for lossless recovery',
            detail: { messageId: message.id, toolUseId: message.id },
          });
        }
        const stateDelta = toolCallStateDelta(message);
        events.push({
          ...base,
          id: newId(),
          role: 'model',
          author: 'agent',
          ...storedToolActivityIdentity(message),
          ...(unreplayable ? { modelVisibility: 'hidden' as const } : {}),
          content: {
            kind: 'function_call',
            id: message.id,
            name: message.toolName,
            args: message.args,
            ...(message.providerOptions !== undefined
              ? { providerOptions: structuredClone(message.providerOptions) }
              : {}),
            ...(message.providerExecuted !== undefined
              ? { providerExecuted: message.providerExecuted }
              : {}),
          },
          ...(stateDelta ? { actions: { stateDelta } } : {}),
          // Carry the persisted step id into refs.stepId so post-restart model
          // replay can re-pair this call with its assistant step, matching the
          // live tool_start path (see model-history step grouping).
          refs: {
            storedMessageId: message.id,
            toolCallId: message.id,
            ...(message.parentToolCallId !== undefined
              ? { parentToolCallId: message.parentToolCallId }
              : {}),
            ...(message.parentOperationId !== undefined
              ? { parentOperationId: message.parentOperationId }
              : {}),
            ...(message.stepId !== undefined ? { stepId: message.stepId } : {}),
          },
        });
        break;
      }

      case 'tool_result': {
        if (conversationTextOnly) break;
        // Same rule as the call it answers: a result the provider cannot be
        // shown again is kept as a transcript row and hidden from replay. A
        // result whose call is not in this turn is hidden for the same reason —
        // a lone result is not a request a provider would accept.
        const call = safePriorToolCall(toolCalls, message);
        const unreplayable =
          !call || (message.providerExecuted === true && message.providerOutput === undefined);
        if (!call) {
          diagnostics.push({
            code: 'skipped_unmatched_tool_result',
            message:
              'tool_result has no earlier same-turn tool_call, so its RuntimeEvent stays out of model replay',
            detail: {
              messageId: message.id,
              toolUseId: message.toolUseId,
              runId: input.run.runId,
              turnId: input.run.turnId,
            },
          });
        }
        events.push({
          ...base,
          id: newId(),
          role: 'tool',
          author: 'tool',
          ...storedToolActivityIdentity(call ?? message),
          ...(unreplayable ? { modelVisibility: 'hidden' as const } : {}),
          content: {
            kind: 'function_response',
            id: message.toolUseId,
            name: call?.toolName ?? '',
            result: message.content,
            isError: message.isError,
            ...(message.providerExecuted !== undefined
              ? { providerExecuted: message.providerExecuted }
              : {}),
            ...(message.providerExecuted && message.providerOutput !== undefined
              ? { providerOutput: structuredClone(message.providerOutput) }
              : {}),
          },
          ...(message.durationMs !== undefined
            ? { actions: { stateDelta: { durationMs: message.durationMs } } }
            : {}),
          refs: {
            storedMessageId: message.id,
            toolCallId: message.toolUseId,
            ...(call?.parentToolCallId !== undefined
              ? { parentToolCallId: call.parentToolCallId }
              : {}),
            ...(call?.parentOperationId !== undefined
              ? { parentOperationId: call.parentOperationId }
              : {}),
          },
        });
        break;
      }

      // The decision names the tool it answered for, so it converts on its own
      // evidence; a matching call in the same turn is confirmation, not a
      // requirement.
      case 'permission_decision':
        if (conversationTextOnly) break;
        events.push({
          ...base,
          id: newId(),
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: recoveryState(now, message),
            permissionDecision: {
              requestId: message.id,
              decision: message.decision,
              toolName: message.toolName,
              ...(message.rememberForTurn !== undefined
                ? { rememberForTurn: message.rememberForTurn }
                : {}),
              ...(message.reviewer !== undefined ? { reviewer: message.reviewer } : {}),
              ...(message.rationale !== undefined ? { rationale: message.rationale } : {}),
              ...(message.riskLevel !== undefined ? { riskLevel: message.riskLevel } : {}),
              ...(message.hint !== undefined ? { hint: message.hint } : {}),
            },
          },
          refs: { storedMessageId: message.id, toolCallId: message.toolUseId },
        });
        break;

      case 'token_usage':
        if (conversationTextOnly) break;
        events.push({
          ...base,
          id: newId(),
          role: 'system',
          author: 'system',
          actions: {
            stateDelta: recoveryState(now, message),
            tokenUsage: tokenUsageFromMessage(message),
          },
          refs: {
            storedMessageId: message.id,
            ...(message.providerRequestTraceId !== undefined
              ? { providerRequestTraceId: message.providerRequestTraceId }
              : {}),
          },
        });
        break;

      // Both are already accounted for elsewhere: the turn's ending becomes the
      // terminal RuntimeEvent below, and a coordination record is the WorkHub's
      // own durable proof, which no run ledger owns a copy of.
      case 'turn_state':
      case 'workhub_coordination':
        break;

      // A note that names a turn is that invocation's own fact, so it converts.
      // A session-level kind that somehow carries a turnId is not: it says
      // something about the Session, and the Session transcript keeps it.
      case 'system_note':
        if (conversationTextOnly) break;
        if (!isRuntimeSystemNoteKind(message.kind)) {
          diagnostics.push({
            code: 'skipped_high_risk_message',
            message:
              'session-level system_note is not recovered into a run ledger because it does not belong to this run',
            detail: {
              messageId: message.id,
              kind: message.kind,
              runId: input.run.runId,
              turnId: input.run.turnId,
            },
          });
          break;
        }
        events.push({
          ...base,
          id: newId(),
          role: 'system',
          author: 'system',
          modelVisibility: 'hidden',
          content: {
            kind: 'system_note',
            note: message.kind,
            ...(message.data !== undefined ? { data: structuredClone(message.data) } : {}),
          },
          actions: { stateDelta: recoveryState(now, message) },
          refs: { storedMessageId: message.id },
        });
        break;
    }
  }

  const terminal = terminalRuntimeEvent({
    run: input.run,
    outcome: input.outcome,
    turnMessages,
    invocationId,
    newId,
    now,
  });
  if (terminal.event) events.push(terminal.event);
  if (terminal.diagnostic) diagnostics.push(terminal.diagnostic);

  return { events, diagnostics };
}

function storedToolActivityIdentity(message: {
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
}): Pick<RuntimeEvent, 'origin' | 'modelVisibility'> {
  return {
    ...(message.origin !== undefined ? { origin: message.origin } : {}),
    ...(message.modelVisibility !== undefined ? { modelVisibility: message.modelVisibility } : {}),
  };
}

function recoveryState(now: () => number, message: StoredMessage): Record<string, unknown> {
  const state: RuntimeEventBackfillRecoveryState = {
    kind: 'runtime_event_backfill',
    source: 'legacy_stored_message',
    reason: 'missing_runtime_event_ledger',
    sourceMessageId: messageId(message),
    sourceMessageType: message.type,
    confidence: 'lossless',
    generatedAt: now(),
    version: 1,
  };
  return { [RUNTIME_EVENT_BACKFILL_STATE_KEY]: state };
}

function toolCallStateDelta(message: ToolCallMessage): Record<string, unknown> | undefined {
  const stateDelta = {
    ...(message.activityKind !== undefined ? { activityKind: message.activityKind } : {}),
    ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
    ...(message.intent !== undefined ? { intent: message.intent } : {}),
  };
  return Object.keys(stateDelta).length > 0 ? stateDelta : undefined;
}

function terminalRecoveryState(
  now: () => number,
  message: TurnStateMessage | undefined,
): Record<string, unknown> {
  const state: RuntimeEventBackfillRecoveryState = {
    kind: 'runtime_event_backfill',
    source: 'legacy_stored_message',
    reason: 'missing_runtime_event_ledger',
    ...(message ? { sourceMessageId: message.id, sourceMessageType: message.type } : {}),
    confidence: 'lossless',
    generatedAt: now(),
    version: 1,
  };
  return { [RUNTIME_EVENT_BACKFILL_STATE_KEY]: state };
}

function terminalRuntimeEvent(input: {
  run: RunIdentity;
  outcome: RuntimeEventBackfillOutcome | undefined;
  turnMessages: readonly StoredMessage[];
  invocationId: string;
  newId: () => string;
  now: () => number;
}): { event?: RuntimeEvent; diagnostic?: RuntimeEventBackfillDiagnostic } {
  const turnState = latestTurnState(input.turnMessages);
  const readStatus = terminalStatus(input.outcome, turnState);
  // An invocation with no ending is not a legal ledger state, and leaving one
  // open would strand the turn in recovery forever. Incomplete legacy evidence
  // does not get to claim the turn completed, so it ends as the failure it
  // actually was, marked so a reader can tell it apart from a recorded one.
  const status = readStatus ?? 'failed';
  const diagnostic: RuntimeEventBackfillDiagnostic | undefined = readStatus
    ? undefined
    : {
        code: 'synthesized_terminal_event',
        message:
          'terminal RuntimeEvent was synthesized because legacy terminal evidence is incomplete',
        detail: {
          runId: input.run.runId,
          turnId: input.run.turnId,
          declaredStatus: input.outcome?.status,
          turnStatus: turnState?.status,
        },
      };
  const ts = turnState?.ts ?? input.outcome?.ts ?? input.now();
  const failureClass =
    status === 'failed'
      ? (turnState?.errorClass ?? input.outcome?.failureClass ?? 'missing_terminal_event')
      : undefined;
  const abortSource =
    status === 'aborted'
      ? (turnState?.abortSource ??
        input.outcome?.abortSource ??
        (turnState?.status === 'aborted' ? 'unknown' : undefined))
      : undefined;
  return {
    event: {
      id: input.newId(),
      invocationId: input.invocationId,
      runId: input.run.runId,
      sessionId: input.run.sessionId,
      turnId: input.run.turnId,
      ts,
      partial: false,
      role: 'system',
      author: 'system',
      status,
      actions: {
        endInvocation: true,
        stateDelta: {
          ...terminalRecoveryState(input.now, turnState),
          ...(failureClass !== undefined ? { failureClass, errorClass: failureClass } : {}),
          ...(abortSource !== undefined ? { abortSource } : {}),
        },
      },
      ...(turnState ? { refs: { storedMessageId: turnState.id } } : {}),
    },
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function terminalStatus(
  outcome: RuntimeEventBackfillOutcome | undefined,
  turnState: TurnStateMessage | undefined,
): RuntimeEventStatus | undefined {
  const legacyStatus = turnState?.status;
  const declared = outcome?.status;
  if (legacyStatus === 'completed' || declared === 'completed') return 'completed';
  if (legacyStatus === 'failed' && declared === 'failed') return 'failed';
  if (
    (legacyStatus === 'failed' || declared === 'failed') &&
    (outcome?.failureClass || turnState?.errorClass)
  )
    return 'failed';
  if (legacyStatus === 'aborted' && declared === 'cancelled') return 'aborted';
  if ((legacyStatus === 'aborted' || declared === 'cancelled') && turnState?.abortSource)
    return 'aborted';
  return undefined;
}

function latestTurnState(messages: readonly StoredMessage[]): TurnStateMessage | undefined {
  return messages
    .filter((message): message is TurnStateMessage => message.type === 'turn_state')
    .at(-1);
}

function safePriorToolCall(
  toolCalls: ReadonlyMap<string, ToolCallMessage>,
  message: ToolResultMessage | PermissionDecisionMessage,
): ToolCallMessage | undefined {
  const call = toolCalls.get(message.toolUseId);
  if (!call) return undefined;
  return call.ts <= message.ts ? call : undefined;
}

function tokenUsageFromMessage(
  message: TokenUsageMessage,
): NonNullable<RuntimeEvent['actions']>['tokenUsage'] {
  return {
    input: message.input,
    output: message.output,
    ...(message.cacheHitInput !== undefined ? { cacheHitInput: message.cacheHitInput } : {}),
    ...(message.cacheMissInput !== undefined ? { cacheMissInput: message.cacheMissInput } : {}),
    ...(message.cacheWriteInput !== undefined ? { cacheWriteInput: message.cacheWriteInput } : {}),
    ...(message.cacheMissInputSource !== undefined
      ? { cacheMissInputSource: message.cacheMissInputSource }
      : {}),
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(message.total !== undefined ? { total: message.total } : {}),
    ...(message.rawFinishReason !== undefined ? { rawFinishReason: message.rawFinishReason } : {}),
    ...(message.runtimeSteps !== undefined ? { runtimeSteps: message.runtimeSteps } : {}),
    ...(message.cacheRead !== undefined ? { cacheRead: message.cacheRead } : {}),
    ...(message.cacheCreation !== undefined ? { cacheCreation: message.cacheCreation } : {}),
    ...(message.costUsd !== undefined ? { costUsd: message.costUsd } : {}),
    ...(message.contextRemaining !== undefined
      ? { contextRemaining: message.contextRemaining }
      : {}),
    ...(message.systemPromptHash !== undefined
      ? { systemPromptHash: message.systemPromptHash }
      : {}),
    ...(message.prefixHash !== undefined ? { prefixHash: message.prefixHash } : {}),
    ...(message.prefixChangeReason !== undefined
      ? { prefixChangeReason: message.prefixChangeReason }
      : {}),
    ...(message.requestShapeHash !== undefined
      ? { requestShapeHash: message.requestShapeHash }
      : {}),
    ...(message.requestShapeChangeReason !== undefined
      ? { requestShapeChangeReason: message.requestShapeChangeReason }
      : {}),
    ...(message.promptSegments !== undefined ? { promptSegments: message.promptSegments } : {}),
    ...(message.contextBudget !== undefined ? { contextBudget: message.contextBudget } : {}),
    ...(message.lastRequestAnchor !== undefined
      ? { lastRequestAnchor: message.lastRequestAnchor }
      : {}),
  };
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
}

function messageId(message: StoredMessage): string {
  return 'id' in message && typeof message.id === 'string' ? message.id : '';
}
