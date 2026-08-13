import type { AgentRunHeader } from '@maka/core/agent-run';
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
  | 'skipped_unmatched_permission_decision'
  | 'skipped_unsafe_terminal_state';

export interface RuntimeEventBackfillDiagnostic {
  code: RuntimeEventBackfillDiagnosticCode;
  message: string;
  detail?: unknown;
}

export interface RuntimeEventBackfillInput {
  run: AgentRunHeader;
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
        if (message.providerExecuted === true && !replayableProviderToolUseIds.has(message.id)) {
          diagnostics.push({
            code: 'skipped_provider_native_replay_gap',
            message:
              'provider-native tool history requires the opaque provider output for lossless recovery',
            detail: { messageId: message.id, toolUseId: message.id },
          });
          break;
        }
        const stateDelta = toolCallStateDelta(message);
        events.push({
          ...base,
          id: newId(),
          role: 'model',
          author: 'agent',
          ...storedToolActivityIdentity(message),
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
        if (message.providerExecuted === true && message.providerOutput === undefined) {
          break;
        }
        const call = safePriorToolCall(toolCalls, message);
        if (!call) {
          diagnostics.push({
            code: 'skipped_unmatched_tool_result',
            message:
              'tool_result requires an earlier same-turn tool_call to recover RuntimeEvent function_response',
            detail: {
              messageId: message.id,
              toolUseId: message.toolUseId,
              runId: input.run.runId,
              turnId: input.run.turnId,
            },
          });
          break;
        }
        events.push({
          ...base,
          id: newId(),
          role: 'tool',
          author: 'tool',
          ...storedToolActivityIdentity(call),
          content: {
            kind: 'function_response',
            id: message.toolUseId,
            name: call.toolName,
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
            ...(call.parentToolCallId !== undefined
              ? { parentToolCallId: call.parentToolCallId }
              : {}),
            ...(call.parentOperationId !== undefined
              ? { parentOperationId: call.parentOperationId }
              : {}),
          },
        });
        break;
      }

      case 'permission_decision': {
        if (conversationTextOnly) break;
        const call = safePriorToolCall(toolCalls, message);
        if (!call) {
          diagnostics.push({
            code: 'skipped_unmatched_permission_decision',
            message:
              'permission_decision requires an earlier same-turn tool_call to recover RuntimeEvent permissionDecision',
            detail: {
              messageId: message.id,
              toolUseId: message.toolUseId,
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
          actions: {
            stateDelta: recoveryState(now, message),
            permissionDecision: {
              requestId: message.id,
              decision: message.decision,
              ...(message.rememberForTurn !== undefined
                ? { rememberForTurn: message.rememberForTurn }
                : {}),
            },
          },
          refs: { storedMessageId: message.id, toolCallId: call.id },
        });
        break;
      }

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

      case 'turn_state':
        break;

      case 'system_note':
        if (conversationTextOnly) break;
        diagnostics.push({
          code: 'skipped_high_risk_message',
          message:
            'system_note is not recovered into a run ledger because session-level notes may not belong to this run',
          detail: {
            messageId: message.id,
            kind: message.kind,
            runId: input.run.runId,
            turnId: input.run.turnId,
          },
        });
        break;
    }
  }

  const terminal = terminalRuntimeEvent({ run: input.run, turnMessages, invocationId, newId, now });
  if (terminal.event) {
    events.push(terminal.event);
  } else if (terminal.diagnostic) {
    diagnostics.push(terminal.diagnostic);
  }

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
  run: AgentRunHeader;
  turnMessages: readonly StoredMessage[];
  invocationId: string;
  newId: () => string;
  now: () => number;
}): { event?: RuntimeEvent; diagnostic?: RuntimeEventBackfillDiagnostic } {
  const turnState = latestTurnState(input.turnMessages);
  const status = terminalStatus(input.run, turnState);
  if (!status) {
    return {
      diagnostic: {
        code: 'skipped_unsafe_terminal_state',
        message:
          'terminal RuntimeEvent was not recovered because legacy terminal evidence is incomplete',
        detail: {
          runId: input.run.runId,
          turnId: input.run.turnId,
          runStatus: input.run.status,
          turnStatus: turnState?.status,
        },
      },
    };
  }
  const ts = turnState?.ts ?? input.run.completedAt ?? input.run.updatedAt;
  const failureClass =
    status === 'failed' ? (turnState?.errorClass ?? input.run.failureClass) : undefined;
  const abortSource =
    status === 'aborted'
      ? (turnState?.abortSource ??
        input.run.abortSource ??
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
  };
}

function terminalStatus(
  run: AgentRunHeader,
  turnState: TurnStateMessage | undefined,
): RuntimeEventStatus | undefined {
  const legacyStatus = turnState?.status;
  if (legacyStatus === 'completed' || run.status === 'completed') return 'completed';
  if (legacyStatus === 'failed' && run.status === 'failed') return 'failed';
  if (
    (legacyStatus === 'failed' || run.status === 'failed') &&
    (run.failureClass || turnState?.errorClass)
  )
    return 'failed';
  if (legacyStatus === 'aborted' && run.status === 'cancelled') return 'aborted';
  if ((legacyStatus === 'aborted' || run.status === 'cancelled') && turnState?.abortSource)
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
  };
}

function messageTurnId(message: StoredMessage): string | undefined {
  return 'turnId' in message && typeof message.turnId === 'string' ? message.turnId : undefined;
}

function messageId(message: StoredMessage): string {
  return 'id' in message && typeof message.id === 'string' ? message.id : '';
}
