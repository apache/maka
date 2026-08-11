import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunInspectDocument, SessionInspectDocument } from '@maka/core/execution-inspect';
import {
  decodeClientFrame,
  decodeHostFrame,
  EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('execution inspect protocol', () => {
  test('decodes closed resolution and evidence query shapes', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-resolve',
        operation: 'execution.inspect.resolve',
        input: { id: 'run-1', requestedKind: 'agent_run', sessionId: 'session-1' },
      }),
      {
        requestId: 'request-resolve',
        operation: 'execution.inspect.resolve',
        input: { id: 'run-1', requestedKind: 'agent_run', sessionId: 'session-1' },
      },
    );
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
  });

  test('rejects open shapes, inconsistent resolution, and oversized payloads', () => {
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
            nextOffset: 2,
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-status',
          operation: 'execution.inspect.resolve',
          ok: true,
          result: { status: 'resolved', candidates: [], truncated: false },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-page',
          operation: 'execution.inspect.resolve',
          ok: true,
          result: {
            status: 'ambiguous',
            candidates: Array.from(
              { length: EXECUTION_INSPECT_CANDIDATE_MAX_ITEMS + 1 },
              (_, index) => ({
                kind: 'agent_run',
                id: 'run-1',
                sessionId: `session-${index}`,
              }),
            ),
            truncated: true,
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
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['execution.inspect.resolve'].assertOutputForInput?.(
          { id: 'run-1', requestedKind: 'agent_run', sessionId: 'session-1' },
          {
            status: 'resolved',
            candidates: [{ kind: 'agent_run', id: 'run-1', sessionId: 'session-2' }],
            truncated: false,
          },
        ),
      isProtocolError,
    );
  });
});

function tracePage() {
  return {
    kind: 'session_trace_page' as const,
    schemaVersion: 1 as const,
    sessionId: 'session-1',
    revision: `sha256:${'a'.repeat(64)}` as const,
    offset: 0,
    turns: [],
    totals: {
      durationMs: 0,
      modelAttempts: 0,
      retries: 0,
      compactions: 0,
      inputTokens: 0,
      outputTokens: 0,
      unpricedAttempts: 0,
    },
    coverage: {
      modelCalls: 'none' as const,
      turnsMissingModelCalls: [],
      unreadableRecords: 0,
      turnsWithFewerModelCallsThanSteps: [],
    },
    nextOffset: null,
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
    totals: {
      durationMs: 1,
      modelAttempts: 0,
      retries: 0,
      compactions: 0,
      inputTokens: 0,
      outputTokens: 0,
      unpricedAttempts: 0,
    },
  };
}

function agentRunDocument(sessionId = 'session-1', agentRunId = 'run-1'): AgentRunInspectDocument {
  return {
    schemaVersion: 'maka.agent_run_inspect.v1',
    kind: 'agent_run',
    agentRun: {
      sessionId,
      agentRunId,
      turnId: 'turn-1',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      completedAt: 2,
    },
    sources: {
      operationalEventCount: 0,
      runtimeEventCount: 0,
      health: {
        runtimeLedger: 'missing',
        runtimeTerminalPresent: false,
        operationalTerminalPresent: false,
        statusConsistency: 'incomplete',
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
      lastUsedAt: 2,
      isArchived: false,
    },
    agentRuns: [],
    diagnostics: [],
  };
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}
