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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  SESSION_EFFECT_OPERATION_SPECS,
  SESSION_RECAP_RAW_MAX_BYTES,
} from '../protocol/index.js';

test('Session recap is one ready command with stable effect identity', () => {
  assert.deepEqual(Object.keys(SESSION_EFFECT_OPERATION_SPECS), ['session.recap.generate']);
  assert.deepEqual(
    {
      mode: SESSION_EFFECT_OPERATION_SPECS['session.recap.generate'].mode,
      availability: SESSION_EFFECT_OPERATION_SPECS['session.recap.generate'].availability,
      errors: SESSION_EFFECT_OPERATION_SPECS['session.recap.generate'].errors,
    },
    {
      mode: 'command',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'not_found',
        'session_archived',
        'operation_conflict',
        'persistence_failed',
        'outcome_unknown',
        'internal_failure',
      ],
    },
  );

  const request = {
    requestId: 'request-1',
    operation: 'session.recap.generate',
    input: { sessionId: 'session-1', effectId: 'effect-1', reason: 'manual' },
  };
  assert.deepEqual(decodeClientFrame(request), request);
});

test('Session recap exposes only bounded generated text or a closed failure class', () => {
  for (const result of [
    {
      kind: 'generated',
      effectId: 'effect-1',
      reason: 'manual',
      text: 'We wired Host-owned Session effects.',
      raw: 'We wired Host-owned Session effects.',
    },
    {
      kind: 'failed',
      effectId: 'effect-2',
      reason: 'idle',
      errorClass: 'timeout',
    },
  ]) {
    const response = {
      requestId: 'request-1',
      operation: 'session.recap.generate',
      ok: true,
      result,
    };
    assert.deepEqual(decodeHostFrame(response), response);
  }

  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.recap.generate',
        ok: true,
        result: {
          kind: 'generated',
          effectId: 'effect-1',
          reason: 'manual',
          text: 'bounded',
          raw: 'x'.repeat(SESSION_RECAP_RAW_MAX_BYTES + 1),
        },
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.recap.generate',
        ok: true,
        result: {
          kind: 'failed',
          effectId: 'effect-1',
          reason: 'manual',
          errorClass: 'raw_provider_error',
        },
      }),
    isProtocolError,
  );
});

test('Session recap rejects open or uncorrelated wire values', () => {
  assert.throws(
    () =>
      decodeClientFrame({
        requestId: 'request-1',
        operation: 'session.recap.generate',
        input: {
          sessionId: 'session-1',
          effectId: 'effect-1',
          reason: 'manual',
          model: 'client-selected-model',
        },
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      SESSION_EFFECT_OPERATION_SPECS['session.recap.generate'].assertOutputForInput?.(
        { sessionId: 'session-1', effectId: 'effect-1', reason: 'manual' },
        {
          kind: 'failed',
          effectId: 'effect-other',
          reason: 'manual',
          errorClass: 'provider',
        },
      ),
    isProtocolError,
  );
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
