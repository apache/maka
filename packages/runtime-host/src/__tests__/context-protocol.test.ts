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
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';

test('context operations preserve bounded exact wire values', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request-query',
      operation: 'context.diagnostics.query',
      input: { sessionId: 'session-1' },
    }),
    {
      requestId: 'request-query',
      operation: 'context.diagnostics.query',
      input: { sessionId: 'session-1' },
    },
  );
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request-compact',
      operation: 'context.compact',
      input: { sessionId: 'session-1', turnId: 'compact-1' },
    }),
    {
      requestId: 'request-compact',
      operation: 'context.compact',
      input: { sessionId: 'session-1', turnId: 'compact-1' },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request-query',
      operation: 'context.diagnostics.query',
      ok: true,
      result: {
        status: 'available',
        providerId: 'openrouter',
        modelId: 'openrouter/free',
        completedAt: 10,
        inputTokens: 20,
        contextWindow: 128_000,
        composition: {
          segments: [{ kind: 'messages', bytes: 80 }],
          tools: [{ name: 'Bash', bytes: 40 }],
          remainingTools: { count: 3, bytes: 90 },
        },
        compaction: {
          kind: 'history',
          phase: 'pre_turn',
          eventCount: 4,
          turnCount: 2,
          estimatedTokens: 12,
        },
      },
    }),
    {
      requestId: 'request-query',
      operation: 'context.diagnostics.query',
      ok: true,
      result: {
        status: 'available',
        providerId: 'openrouter',
        modelId: 'openrouter/free',
        completedAt: 10,
        inputTokens: 20,
        contextWindow: 128_000,
        composition: {
          segments: [{ kind: 'messages', bytes: 80 }],
          tools: [{ name: 'Bash', bytes: 40 }],
          remainingTools: { count: 3, bytes: 90 },
        },
        compaction: {
          kind: 'history',
          phase: 'pre_turn',
          eventCount: 4,
          turnCount: 2,
          estimatedTokens: 12,
        },
      },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request-compact',
      operation: 'context.compact',
      ok: true,
      result: {
        sessionId: 'session-1',
        turnId: 'compact-1',
        runId: 'run-compact-1',
        status: 'running',
      },
    }),
    {
      requestId: 'request-compact',
      operation: 'context.compact',
      ok: true,
      result: {
        sessionId: 'session-1',
        turnId: 'compact-1',
        runId: 'run-compact-1',
        status: 'running',
      },
    },
  );
});

test('context operations reject open shapes and invalid diagnostics', () => {
  assert.throws(
    () =>
      decodeClientFrame({
        requestId: 'request-query',
        operation: 'context.diagnostics.query',
        input: { sessionId: 'session-1', includeTrace: true },
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request-query',
        operation: 'context.diagnostics.query',
        ok: true,
        result: {
          status: 'available',
          providerId: 'openrouter',
          modelId: 'openrouter/free',
          completedAt: 10,
          contextWindow: 0,
        },
      }),
    isProtocolError,
  );
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
