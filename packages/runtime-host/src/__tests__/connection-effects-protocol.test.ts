import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';
import { RuntimeHostProtocolError } from '../protocol/errors.js';

const EXPECTED = {
  connectionId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
};

describe('Runtime Host connection effects protocol', () => {
  test('bounds transient onboarding secrets, models, and save selections', () => {
    const verify = request('connection.onboarding.verify', {
      providerType: 'openrouter',
      apiKey: 'transient-secret',
    });
    const save = request('connection.onboarding.save', {
      providerType: 'openrouter',
      apiKey: 'transient-secret',
      enabledModelIds: ['openrouter/free'],
    });
    assert.deepEqual(decodeClientFrame(verify), verify);
    assert.deepEqual(decodeClientFrame(save), save);
    assert.deepEqual(
      decodeHostFrame(
        response('connection.onboarding.verify', {
          kind: 'verified',
          models: [{ id: 'openrouter/free', contextWindow: 128_000 }],
        }),
      ),
      response('connection.onboarding.verify', {
        kind: 'verified',
        models: [{ id: 'openrouter/free', contextWindow: 128_000 }],
      }),
    );
    assert.deepEqual(
      decodeHostFrame(response('connection.onboarding.save', { kind: 'saved' })),
      response('connection.onboarding.save', { kind: 'saved' }),
    );
    assertInvalidRequest('connection.onboarding.save', {
      providerType: 'openrouter',
      apiKey: null,
      enabledModelIds: [],
    });
    assertInvalidResponse('connection.onboarding.verify', {
      kind: 'verified',
      models: [],
    });
    assertInvalidResponse('connection.onboarding.save', {
      kind: 'failed',
      errorClass: 'auth',
      secret: 'forbidden',
    });
  });

  test('requires a stable connection identity and an explicit nullable test model', () => {
    const fetch = request('connection.models.fetch', { connectionId: EXPECTED.connectionId });
    const connectionTest = request('connection.test.run', {
      connectionId: EXPECTED.connectionId,
      modelId: 'model-1',
    });
    const defaultModelTest = request('connection.test.run', {
      connectionId: EXPECTED.connectionId,
      modelId: null,
    });
    assert.deepEqual(decodeClientFrame(fetch), fetch);
    assert.deepEqual(decodeClientFrame(connectionTest), connectionTest);
    assert.deepEqual(decodeClientFrame(defaultModelTest), defaultModelTest);

    assertInvalidRequest('connection.models.fetch', {
      connectionId: EXPECTED.connectionId,
      secret: 'forbidden',
    });
    assertInvalidRequest('connection.test.run', { connectionId: EXPECTED.connectionId });
    assertInvalidRequest('connection.test.run', {
      connectionId: EXPECTED.connectionId,
      modelId: 'x'.repeat(1_025),
    });
  });

  test('accepts bounded model summaries and rejects model arrays or raw failures', () => {
    const committedResult = {
      kind: 'committed',
      catalogRevision: 2,
      connection: { ...EXPECTED, revision: 2 },
      modelCount: 2_048,
      source: 'fetched',
      fetchedAt: 1_000,
    };
    const committed = response('connection.models.fetch', committedResult);
    assert.deepEqual(decodeHostFrame(committed), committed);

    for (const result of [
      { kind: 'failed', errorClass: 'timeout' },
      { kind: 'rejected', reason: 'credential_not_configured' },
      { kind: 'superseded', changed: ['credential', 'network_proxy'] },
    ]) {
      const frame = response('connection.models.fetch', result);
      assert.deepEqual(decodeHostFrame(frame), frame);
    }

    assertInvalidResponse('connection.models.fetch', {
      ...committedResult,
      models: [{ id: 'secret-model-list' }],
    });
    assertInvalidResponse('connection.models.fetch', {
      kind: 'failed',
      errorClass: 'network',
      message: 'raw provider response',
    });
    assertInvalidResponse('connection.models.fetch', {
      kind: 'superseded',
      changed: ['credential', 'credential'],
    });
  });

  test('keeps one exact and bounded connection test projection', () => {
    const verified = response('connection.test.run', {
      kind: 'committed',
      catalogRevision: 2,
      connection: { ...EXPECTED, revision: 2 },
      test: {
        kind: 'verified',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 42,
      },
    });
    const failedResult = {
      kind: 'committed',
      catalogRevision: 2,
      connection: { ...EXPECTED, revision: 2 },
      test: {
        kind: 'failed',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 42,
        statusCode: 401,
        errorClass: 'auth',
      },
    };
    const failed = response('connection.test.run', failedResult);
    const invalidResponse = response('connection.test.run', {
      ...failedResult,
      test: {
        ...failedResult.test,
        statusCode: null,
        errorClass: 'invalid_response',
      },
    });
    assert.deepEqual(decodeHostFrame(verified), verified);
    assert.deepEqual(decodeHostFrame(failed), failed);
    assert.deepEqual(decodeHostFrame(invalidResponse), invalidResponse);

    assertInvalidResponse('connection.test.run', {
      ...failedResult,
      summary: {
        status: 'needs_reauth',
        checkedAt: '2026-07-29T00:00:00.000Z',
        errorClass: 'auth',
      },
    });
    assertInvalidResponse('connection.test.run', {
      ...failedResult,
      test: { ...failedResult.test, providerBody: 'secret response' },
    });
    assertInvalidResponse('connection.test.run', {
      ...failedResult,
      test: { ...failedResult.test, modelId: 'x'.repeat(1_025) },
    });
    assertInvalidResponse('connection.test.run', {
      ...failedResult,
      test: { ...failedResult.test, statusCode: 600 },
    });
  });
});

function request(operation: string, input: unknown) {
  return { requestId: 'request-1', operation, input };
}

function response(operation: string, result: unknown) {
  return { requestId: 'request-1', operation, ok: true, result };
}

function assertInvalidRequest(operation: string, input: unknown): void {
  assert.throws(() => decodeClientFrame(request(operation, input)), isInvalidFrame);
}

function assertInvalidResponse(operation: string, result: unknown): void {
  assert.throws(() => decodeHostFrame(response(operation, result)), isInvalidFrame);
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
