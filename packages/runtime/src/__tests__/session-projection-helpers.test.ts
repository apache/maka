import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { StoredMessage } from '@maka/core/session';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  isTerminalRunStatus,
  statusFromEvent,
  turnStatusFromEvent,
  turnHasRetainedOutput,
} from '../session-projection-helpers.js';

describe('session projection helpers', () => {
  test('buildStatusPatch normalizes blocked reasons and clears non-blocked reasons', () => {
    expect(buildStatusPatch('blocked', 100)).toEqual({
      status: 'blocked',
      blockedReason: 'unknown',
      statusUpdatedAt: 100,
    });
    expect(buildStatusPatch('waiting_for_user', 101, 'permission_required')).toEqual({
      status: 'waiting_for_user',
      blockedReason: undefined,
      statusUpdatedAt: 101,
    });
  });

  test('buildTurnStateMessage preserves lineage and terminal status fields', () => {
    expect(
      buildTurnStateMessage({
        id: 'state-1',
        turnId: 'turn-1',
        ts: 100,
        status: 'aborted',
        lineage: {
          parentTurnId: 'parent',
          retriedFromTurnId: 'retry-source',
          regeneratedFromTurnId: 'regen-source',
          branchOfTurnId: 'branch-source',
          parentSessionId: 'parent-session',
        },
        abortSource: 'renderer.stop_button',
        partialOutputRetained: true,
      }),
    ).toEqual({
      type: 'turn_state',
      id: 'state-1',
      turnId: 'turn-1',
      ts: 100,
      status: 'aborted',
      parentTurnId: 'parent',
      retriedFromTurnId: 'retry-source',
      regeneratedFromTurnId: 'regen-source',
      branchOfTurnId: 'branch-source',
      parentSessionId: 'parent-session',
      abortedAt: 100,
      abortSource: 'renderer.stop_button',
      partialOutputRetained: true,
    });

    expect(
      buildTurnStateMessage({
        id: 'state-2',
        turnId: 'turn-2',
        ts: 101,
        status: 'failed',
        partialOutputRetained: false,
      }),
    ).toMatchObject({
      type: 'turn_state',
      id: 'state-2',
      turnId: 'turn-2',
      ts: 101,
      status: 'failed',
      errorClass: 'unknown',
      partialOutputRetained: false,
    });
  });

  test('turnHasRetainedOutput only treats visible assistant text and tool results as retained output', () => {
    const messages: StoredMessage[] = [
      { type: 'assistant', id: 'blank', turnId: 'turn-1', ts: 1, text: '   ', modelId: 'model' },
      { type: 'assistant', id: 'other', turnId: 'turn-2', ts: 2, text: 'kept', modelId: 'model' },
      {
        type: 'tool_result',
        id: 'tool',
        turnId: 'turn-3',
        ts: 3,
        toolUseId: 'call-1',
        isError: false,
        content: { kind: 'text', text: 'ok' },
      },
    ];

    expect(turnHasRetainedOutput(messages, 'turn-1')).toBe(false);
    expect(turnHasRetainedOutput(messages, 'turn-2')).toBe(true);
    expect(turnHasRetainedOutput(messages, 'turn-3')).toBe(true);
  });

  test('projects terminal run statuses and session terminal events', () => {
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('failed')).toBe(true);
    expect(isTerminalRunStatus('cancelled')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);

    expect(statusFromEvent({ type: 'sandbox_boundary_request', ts: 1 } as never)).toEqual({
      status: 'waiting_for_user',
      blockedReason: 'permission_required',
    });
    expect(statusFromEvent({ type: 'user_question_request', ts: 1 } as never)).toEqual({
      status: 'waiting_for_user',
    });
    expect(statusFromEvent({ type: 'sandbox_boundary_decision_ack', ts: 1 } as never)).toEqual({
      status: 'running',
    });
    expect(
      statusFromEvent({ type: 'sandbox_boundary_decision_ack', ts: 1 } as never, {
        allowInteractionResume: false,
      }),
    ).toBeUndefined();
    expect(statusFromEvent({ type: 'user_question_answer_ack', ts: 1 } as never)).toEqual({
      status: 'running',
    });
    expect(
      statusFromEvent({ type: 'user_question_answer_ack', ts: 1 } as never, {
        allowInteractionResume: false,
      }),
    ).toBeUndefined();
    expect(statusFromEvent({ type: 'error', ts: 1, reason: 'api_key_invalid' } as never)).toEqual({
      status: 'blocked',
      blockedReason: 'NO_REAL_CONNECTION',
    });
    expect(statusFromEvent({ type: 'complete', ts: 1, stopReason: 'user_stop' } as never)).toEqual({
      status: 'aborted',
    });
  });

  test('projects turn terminal events without changing failure classes', () => {
    expect(turnStatusFromEvent({ type: 'abort', ts: 1 } as never)).toEqual({ status: 'aborted' });
    expect(turnStatusFromEvent({ type: 'error', ts: 1, reason: 'tool_failed' } as never)).toEqual({
      status: 'failed',
      errorClass: 'tool_failed',
    });
    expect(
      turnStatusFromEvent({ type: 'complete', ts: 1, stopReason: 'user_stop' } as never),
    ).toEqual({
      status: 'aborted',
    });
    expect(
      turnStatusFromEvent({ type: 'complete', ts: 1, stopReason: 'permission_handoff' } as never),
    ).toEqual({
      status: 'completed',
    });
  });
});
