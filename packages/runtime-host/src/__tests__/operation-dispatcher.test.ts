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

  test('records handler failures and converts them to declared internal_failure', async (t) => {
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
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
        throw new Error('api_key=sk-secretvalue123');
      }),
      context,
    );
    assert.deepEqual(thrown, internalFailure());
    assert.equal(logs.length, malformedOutcomes.length + 1);
    assert.match(logs.at(-1) ?? '', /unexpected turn\.query failure/);
    assert.match(logs.at(-1) ?? '', /\[redacted\]/i);
    assert.doesNotMatch(logs.at(-1) ?? '', /sk-secretvalue123/);
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

  test('revalidates Message operation outcomes through the shared decoder', async (t) => {
    t.mock.method(console, 'error', () => undefined);
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
