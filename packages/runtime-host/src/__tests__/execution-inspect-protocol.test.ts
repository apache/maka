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
import { describe, test } from 'node:test';
import type { AgentRunInspectDocument, SessionInspectDocument } from '@maka/core/execution-inspect';
import {
  decodeClientFrame,
  decodeHostFrame,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  HOST_OPERATION_SPECS,
} from '../protocol/index.js';

describe('execution inspect protocol', () => {
  test('decodes closed evidence query shapes', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-trace',
        operation: 'execution.inspect.query',
        input: { kind: 'session_trace_start', sessionId: 'session-1' },
      }),
      {
        requestId: 'request-trace',
        operation: 'execution.inspect.query',
        input: { kind: 'session_trace_start', sessionId: 'session-1' },
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-turn-trace',
        operation: 'execution.inspect.query',
        input: { kind: 'turn_trace', sessionId: 'session-1', turnId: 'turn-1' },
      }),
      {
        requestId: 'request-turn-trace',
        operation: 'execution.inspect.query',
        input: { kind: 'turn_trace', sessionId: 'session-1', turnId: 'turn-1' },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-query',
        operation: 'execution.inspect.query',
        ok: true,
        result: { kind: 'agent_run', document: agentRunDocument() },
      }),
      {
        requestId: 'request-query',
        operation: 'execution.inspect.query',
        ok: true,
        result: { kind: 'agent_run', document: agentRunDocument() },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-turn-trace',
        operation: 'execution.inspect.query',
        ok: true,
        result: { kind: 'turn_trace', sessionId: 'session-1', turn: turnTrace() },
      }),
      {
        requestId: 'request-turn-trace',
        operation: 'execution.inspect.query',
        ok: true,
        result: { kind: 'turn_trace', sessionId: 'session-1', turn: turnTrace() },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-trace-page',
        operation: 'execution.inspect.query',
        ok: true,
        result: tracePage(),
      }),
      {
        requestId: 'request-trace-page',
        operation: 'execution.inspect.query',
        ok: true,
        result: tracePage(),
      },
    );
  });

  test('rejects legacy TraceTotals on Session pages and Turn traces', () => {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-legacy-page-totals',
          operation: 'execution.inspect.query',
          ok: true,
          result: { ...tracePage(), totals: legacyTraceTotals() },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-legacy-turn-totals',
          operation: 'execution.inspect.query',
          ok: true,
          result: {
            kind: 'turn_trace',
            sessionId: 'session-1',
            turn: { ...turnTrace(), totals: legacyTraceTotals() },
          },
        }),
      isProtocolError,
    );
  });

  test('rejects open shapes and oversized payloads', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-open',
          operation: 'execution.inspect.query',
          input: { kind: 'session', sessionId: 'session-1', rawStore: true },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-trace-page',
          operation: 'execution.inspect.query',
          ok: true,
          result: {
            ...tracePage(),
            nextCursor: 'not a cursor',
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-open-document',
          operation: 'execution.inspect.query',
          ok: true,
          result: {
            kind: 'agent_run',
            document: { ...agentRunDocument(), rawEvidence: true },
          },
        }),
      isProtocolError,
    );
    const oversized = sessionDocument('session-1');
    oversized.diagnostics.push({
      severity: 'warning',
      code: 'oversized',
      message: 'x'.repeat(EXECUTION_INSPECT_RESULT_MAX_BYTES),
      sessionId: 'session-1',
    });
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-oversized-document',
          operation: 'execution.inspect.query',
          ok: true,
          result: { kind: 'session', document: oversized },
        }),
      isProtocolError,
    );
  });

  test('correlates evidence output with the requested identity', () => {
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['execution.inspect.query'].assertOutputForInput?.(
          { kind: 'turn_trace', sessionId: 'session-1', turnId: 'turn-1' },
          { kind: 'turn_trace', sessionId: 'session-1', turn: turnTrace('turn-2') },
        ),
      isProtocolError,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['execution.inspect.query'].assertOutputForInput?.(
          { kind: 'session', sessionId: 'session-1' },
          { kind: 'session', document: sessionDocument('different-session') },
        ),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-nested-identity',
          operation: 'execution.inspect.query',
          ok: true,
          result: {
            kind: 'session',
            document: {
              ...sessionDocument('session-1'),
              agentRuns: [agentRunDocument('different-session')],
            },
          },
        }),
      isProtocolError,
    );
  });
});

function tracePage() {
  return {
    kind: 'session_trace_page' as const,
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    turns: [],
    coverage: {
      modelCalls: 'none' as const,
      turnsMissingModelCalls: [],
      unreadableRecords: 0,
      oversizedRuns: 0,
      turnsWithFewerModelCallsThanSteps: [],
    },
    nextCursor: null,
  };
}

function turnTrace(turnId = 'turn-1') {
  return {
    turnId,
    runId: 'run-1',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    steps: [],
  };
}

function legacyTraceTotals() {
  return {
    durationMs: 0,
    modelAttempts: 0,
    retries: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    unpricedAttempts: 0,
  };
}

function agentRunDocument(sessionId = 'session-1', agentRunId = 'run-1'): AgentRunInspectDocument {
  return {
    schemaVersion: 'maka.agent_run_inspect.v1',
    kind: 'agent_run',
    agentRun: {
      sessionId,
      agentRunId,
      invocationId: agentRunId,
      turnId: 'turn-1',
      status: 'completed',
      openedAt: 1,
      endedAt: 2,
    },
    sources: {
      operationalEventCount: 0,
      runtimeEventCount: 0,
      health: {
        runtimeLedger: 'missing',
        runtimeTerminalPresent: false,
      },
    },
    tools: {
      callCount: 1,
      responseCount: 0,
      errorResponseCount: 0,
      callsWithoutResponse: [
        {
          toolCallId: 'provider.call:1',
          toolName: 'Read',
          eventId: 'provider/event:1',
        },
      ],
      responsesWithoutCall: [],
    },
    compactionCheckpoints: [],
    diagnostics: [],
  };
}

function sessionDocument(sessionId: string): SessionInspectDocument {
  return {
    schemaVersion: 'maka.session_inspect.v1',
    kind: 'session',
    session: {
      sessionId,
      name: 'Session',
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    agentRuns: [],
    diagnostics: [],
  };
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
