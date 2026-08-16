import type { AgentRunHeader } from '@maka/core/agent-run';
import { failureClassFromCompleteStopReason, type SessionEvent } from '@maka/core/events';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  TurnRecord,
  TurnStateMessage,
} from '@maka/core/session';

export type TurnStateLineage = Partial<
  Pick<
    TurnStateMessage,
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
>;

export interface BuildTurnStateMessageInput {
  id: string;
  turnId: string;
  ts: number;
  status: TurnRecord['status'];
  lineage?: TurnStateLineage;
  errorClass?: string;
  abortSource?: string;
  partialOutputRetained: boolean;
}

export function buildStatusPatch(
  status: SessionStatus,
  ts: number,
  blockedReason?: SessionBlockedReason,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  return {
    status,
    blockedReason: status === 'blocked' ? (blockedReason ?? 'unknown') : undefined,
    statusUpdatedAt: ts,
  };
}

export function buildTurnStateMessage(input: BuildTurnStateMessageInput): TurnStateMessage {
  const lineage = input.lineage ?? {};
  return {
    type: 'turn_state',
    id: input.id,
    turnId: input.turnId,
    ts: input.ts,
    status: input.status,
    ...(lineage.parentTurnId ? { parentTurnId: lineage.parentTurnId } : {}),
    ...(lineage.retriedFromTurnId ? { retriedFromTurnId: lineage.retriedFromTurnId } : {}),
    ...(lineage.regeneratedFromTurnId
      ? { regeneratedFromTurnId: lineage.regeneratedFromTurnId }
      : {}),
    ...(lineage.branchOfTurnId ? { branchOfTurnId: lineage.branchOfTurnId } : {}),
    ...(lineage.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
    ...(input.status === 'aborted' ? { abortedAt: input.ts } : {}),
    ...(input.status === 'aborted' && input.abortSource ? { abortSource: input.abortSource } : {}),
    ...(input.status === 'failed' ? { errorClass: input.errorClass ?? 'unknown' } : {}),
    partialOutputRetained: input.partialOutputRetained,
  };
}

export function turnHasRetainedOutput(messages: readonly StoredMessage[], turnId: string): boolean {
  return messages.some(
    (message) =>
      (message.type === 'assistant' &&
        message.turnId === turnId &&
        message.text.trim().length > 0) ||
      (message.type === 'tool_result' && message.turnId === turnId),
  );
}

export function normalizeStopSessionSource(
  source: 'stop_button' | 'graph_supervisor' | undefined,
): string | undefined {
  switch (source) {
    case 'stop_button':
      return 'renderer.stop_button';
    case 'graph_supervisor':
      return 'graph.supervisor';
    case undefined:
      return undefined;
  }
}

export function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function statusFromEvent(
  event: SessionEvent,
  options: { allowInteractionResume?: boolean } = {},
): { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined {
  switch (event.type) {
    case 'sandbox_boundary_request':
      return { status: 'waiting_for_user', blockedReason: 'permission_required' };
    case 'user_question_request':
      return { status: 'waiting_for_user' };
    case 'sandbox_boundary_decision_ack':
      if (options.allowInteractionResume === false) return undefined;
      return { status: 'running' };
    case 'user_question_answer_ack':
      if (options.allowInteractionResume === false) return undefined;
      return { status: 'running' };
    case 'error':
      return { status: 'blocked', blockedReason: blockedReasonFromErrorReason(event.reason) };
    case 'abort':
      return { status: 'aborted' };
    case 'complete':
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      if (event.stopReason === 'error') return { status: 'blocked', blockedReason: 'unknown' };
      return { status: 'active' };
    default:
      return undefined;
  }
}

export function turnStatusFromEvent(
  event: SessionEvent,
): { status: TurnRecord['status']; errorClass?: string } | undefined {
  switch (event.type) {
    case 'abort':
      return { status: 'aborted' };
    case 'error':
      return { status: 'failed', errorClass: event.reason ?? event.code ?? 'unknown' };
    case 'complete': {
      if (event.stopReason === 'user_stop') return { status: 'aborted' };
      const errorClass = failureClassFromCompleteStopReason(event.stopReason);
      if (errorClass) return { status: 'failed', errorClass };
      return { status: 'completed' };
    }
    default:
      return undefined;
  }
}

function blockedReasonFromErrorReason(reason: string | undefined): SessionBlockedReason {
  if (!reason) return 'unknown';
  if (reason === 'permission_required') return 'permission_required';
  if (reason === 'tool_failed') return 'tool_failed';
  if (reason === 'auth' || reason.includes('api_key') || reason.includes('connection'))
    return 'NO_REAL_CONNECTION';
  return 'unknown';
}
