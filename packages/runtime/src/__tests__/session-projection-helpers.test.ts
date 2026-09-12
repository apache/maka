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
import {
  buildStatusPatch,
  isTerminalRunStatus,
  normalizeStopSessionSource,
  statusFromEvent,
  turnStatusFromEvent,
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
