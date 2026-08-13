import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeClientFrame, decodeHostFrame, RuntimeHostProtocolError } from '../protocol/index.js';

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
