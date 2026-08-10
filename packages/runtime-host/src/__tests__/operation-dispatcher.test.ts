import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { OperationKey, OperationOutcome, RequestFrame } from '../protocol/index.js';
import {
  composeOperationHandlers,
  createUnavailableAccessAuthorityOperationHandlers,
  createUnavailableDomainOperationHandlers,
  dispatchOperation,
  type ConnectionContext,
  type OperationHandlerMap,
} from '../server/operation-dispatcher.js';

const context: ConnectionContext = {
  hostEpoch: 'epoch-1',
  connectionId: 'connection-1',
  surface: 'tui',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

const request = {
  requestId: 'request-1',
  operation: 'turn.query',
  input: { sessionId: 'session-1', turnId: 'turn-1' },
} satisfies RequestFrame;

describe('Runtime Host operation dispatcher', () => {
  test('rejects malformed handler composition', () => {
    const handlers = validHandlers();
    assert.throws(
      () =>
        composeOperationHandlers({
          ...handlers,
          'unknown.operation': handlers['host.status'],
        } as unknown as Partial<OperationHandlerMap>),
      /Unknown Runtime Host operation handler: unknown\.operation/,
    );
    assert.throws(
      () => composeOperationHandlers(handlers, { 'host.status': handlers['host.status'] }),
      /Duplicate Runtime Host operation handler: host\.status/,
    );
    assert.throws(
      () => composeOperationHandlers({ 'host.status': handlers['host.status'] }),
      /Missing Runtime Host operation handlers:/,
    );
    assert.throws(
      () =>
        composeOperationHandlers({
          ...handlers,
          'turn.query': undefined,
        } as unknown as Partial<OperationHandlerMap>),
      /Invalid Runtime Host operation handler: turn\.query/,
    );
  });

  test('converts handler throws and malformed outcomes to declared internal_failure', async () => {
    const malformedOutcomes: unknown[] = [
      { ok: true, result: { sessionId: 'session-1', turnId: 'turn-1' } },
      {
        ok: true,
        result: runningSnapshot(),
        privateState: true,
      },
      { ok: false, error: { code: 'session_busy', message: 'not declared for query' } },
      { ok: false, error: { code: 'not_found', message: 'missing', details: {} } },
      { ok: false, error: 'missing' },
    ];

    for (const outcome of malformedOutcomes) {
      const response = await dispatchOperation(
        request,
        handlersWithQuery(async () => outcome as OperationOutcome<'turn.query'>),
        context,
      );
      assert.deepEqual(response, internalFailure());
    }

    const thrown = await dispatchOperation(
      request,
      handlersWithQuery(async () => {
        throw new Error('private failure');
      }),
      context,
    );
    assert.deepEqual(thrown, internalFailure());
  });

  test('passes only decoded valid success and declared exact failure outcomes', async () => {
    const success = await dispatchOperation(
      request,
      handlersWithQuery(async () => ({ ok: true, result: runningSnapshot() })),
      context,
    );
    assert.deepEqual(success, { ...requestIdentity(), ok: true, result: runningSnapshot() });

    const failure = await dispatchOperation(
      request,
      handlersWithQuery(async () => ({
        ok: false,
        error: { code: 'not_found', message: 'Turn does not exist' },
      })),
      context,
    );
    assert.deepEqual(failure, {
      ...requestIdentity(),
      ok: false,
      error: { code: 'not_found', message: 'Turn does not exist' },
    });
  });

  test('revalidates Message operation outcomes through the shared decoder', async () => {
    const messageRequest = {
      requestId: 'submit-request-1',
      operation: 'turn.message.submit',
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'steer' },
        placement: 'current_turn',
      },
    } satisfies RequestFrame;
    const handlers = validHandlers();
    handlers['turn.message.submit'] = async () =>
      ({
        ok: true,
        result: { disposition: 'steering', queueRevision: 1, privateState: true },
      }) as unknown as OperationOutcome<'turn.message.submit'>;
    assert.deepEqual(await dispatchOperation(messageRequest, handlers, context), {
      requestId: messageRequest.requestId,
      operation: messageRequest.operation,
      ok: false,
      error: { code: 'internal_failure', message: 'Runtime Host operation failed' },
    });

    handlers['turn.message.submit'] = async () => ({
      ok: false,
      error: {
        code: 'outcome_unknown',
        message: 'Message disposition cannot be proven in this Host Epoch',
      },
    });
    assert.deepEqual(await dispatchOperation(messageRequest, handlers, context), {
      requestId: messageRequest.requestId,
      operation: messageRequest.operation,
      ok: false,
      error: {
        code: 'outcome_unknown',
        message: 'Message disposition cannot be proven in this Host Epoch',
      },
    });
  });
});

function validHandlers(): OperationHandlerMap {
  const unavailable = async <K extends OperationKey>(): Promise<OperationOutcome<K>> =>
    ({
      ok: false,
      error: {
        code: 'internal_failure',
        message: 'not used',
      },
    }) as OperationOutcome<K>;
  return {
    'host.status': unavailable,
    'host.diagnostics.query': unavailable,
    'host.upgrade.prepare': unavailable,
    ...createUnavailableAccessAuthorityOperationHandlers(),
    ...createUnavailableDomainOperationHandlers(),
  };
}

function handlersWithQuery(query: OperationHandlerMap['turn.query']): OperationHandlerMap {
  return { ...validHandlers(), 'turn.query': query };
}

function runningSnapshot() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    status: 'running' as const,
  };
}

function requestIdentity() {
  return { requestId: request.requestId, operation: request.operation };
}

function internalFailure() {
  return {
    ...requestIdentity(),
    ok: false,
    error: { code: 'internal_failure', message: 'Runtime Host operation failed' },
  };
}
