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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  isTerminalRunStatus,
  normalizeStopSessionSource,
  statusFromEvent,
  turnStatusFromEvent,
  turnHasRetainedOutput,
  workHubDirectStopAbortSource,
} from '../session-projection-helpers.js';

describe('session projection helpers', () => {
  test('binds WorkHub Stop provenance to one valid action identity', () => {
    assert.equal(
      normalizeStopSessionSource('workhub_direct_stop', 'stop-action'),
      workHubDirectStopAbortSource('stop-action'),
    );
    assert.notEqual(
      workHubDirectStopAbortSource('stop-action'),
      workHubDirectStopAbortSource('different-action'),
    );
    assert.throws(
      () => normalizeStopSessionSource('workhub_direct_stop'),
      /Invalid WorkHub direct-stop action identity/,
    );
    assert.throws(
      () => normalizeStopSessionSource('stop_button', 'stop-action'),
      /requires its dedicated Stop source/,
    );
  });

  test('buildStatusPatch normalizes blocked reasons and clears non-blocked reasons', () => {
    assert.deepStrictEqual(buildStatusPatch('blocked', 100), {
      status: 'blocked',
      blockedReason: 'unknown',
      statusUpdatedAt: 100,
    });
    assert.deepStrictEqual(buildStatusPatch('waiting_for_user', 101, 'permission_required'), {
      status: 'waiting_for_user',
      blockedReason: undefined,
      statusUpdatedAt: 101,
    });
  });

  test('buildTurnStateMessage preserves lineage and terminal status fields', () => {
    assert.deepStrictEqual(
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
      {
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
      },
    );

    assert.partialDeepStrictEqual(
      buildTurnStateMessage({
        id: 'state-2',
        turnId: 'turn-2',
        ts: 101,
        status: 'failed',
        partialOutputRetained: false,
      }),
      {
        type: 'turn_state',
        id: 'state-2',
        turnId: 'turn-2',
        ts: 101,
        status: 'failed',
        errorClass: 'unknown',
        partialOutputRetained: false,
      },
    );
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

    assert.strictEqual(turnHasRetainedOutput(messages, 'turn-1'), false);
    assert.strictEqual(turnHasRetainedOutput(messages, 'turn-2'), true);
    assert.strictEqual(turnHasRetainedOutput(messages, 'turn-3'), true);
  });

  test('projects terminal run statuses and session terminal events', () => {
    assert.strictEqual(isTerminalRunStatus('completed'), true);
    assert.strictEqual(isTerminalRunStatus('failed'), true);
    assert.strictEqual(isTerminalRunStatus('cancelled'), true);
    assert.strictEqual(isTerminalRunStatus('running'), false);

    assert.deepStrictEqual(statusFromEvent({ type: 'sandbox_boundary_request', ts: 1 } as never), {
      status: 'waiting_for_user',
      blockedReason: 'permission_required',
    });
    assert.deepStrictEqual(statusFromEvent({ type: 'user_question_request', ts: 1 } as never), {
      status: 'waiting_for_user',
    });
    assert.deepStrictEqual(statusFromEvent({ type: 'form_request', ts: 1 } as never), {
      status: 'waiting_for_user',
    });
    assert.deepStrictEqual(
      statusFromEvent({ type: 'sandbox_boundary_decision_ack', ts: 1 } as never),
      {
        status: 'running',
      },
    );
    assert.deepStrictEqual(statusFromEvent({ type: 'form_answer_ack', ts: 1 } as never), {
      status: 'running',
    });
    assert.strictEqual(
      statusFromEvent({ type: 'sandbox_boundary_decision_ack', ts: 1 } as never, {
        allowInteractionResume: false,
      }),
      undefined,
    );
    assert.deepStrictEqual(statusFromEvent({ type: 'user_question_answer_ack', ts: 1 } as never), {
      status: 'running',
    });
    assert.strictEqual(
      statusFromEvent({ type: 'user_question_answer_ack', ts: 1 } as never, {
        allowInteractionResume: false,
      }),
      undefined,
    );
    assert.deepStrictEqual(
      statusFromEvent({ type: 'error', ts: 1, reason: 'api_key_invalid' } as never),
      {
        status: 'blocked',
        blockedReason: 'NO_REAL_CONNECTION',
      },
    );
    assert.deepStrictEqual(
      statusFromEvent({ type: 'complete', ts: 1, stopReason: 'user_stop' } as never),
      {
        status: 'aborted',
      },
    );
  });

  test('projects turn terminal events without changing failure classes', () => {
    assert.deepStrictEqual(turnStatusFromEvent({ type: 'abort', ts: 1 } as never), {
      status: 'aborted',
    });
    assert.deepStrictEqual(
      turnStatusFromEvent({ type: 'error', ts: 1, reason: 'tool_failed' } as never),
      {
        status: 'failed',
        errorClass: 'tool_failed',
      },
    );
    assert.deepStrictEqual(
      turnStatusFromEvent({ type: 'complete', ts: 1, stopReason: 'user_stop' } as never),
      {
        status: 'aborted',
      },
    );
    assert.deepStrictEqual(
      turnStatusFromEvent({ type: 'complete', ts: 1, stopReason: 'permission_handoff' } as never),
      {
        status: 'completed',
      },
    );
  });
});
