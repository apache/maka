import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';
import { CONNECTION_EFFECT_OPERATION_SPECS } from '../protocol/connection-effects.js';
import { RuntimeHostProtocolError } from '../protocol/errors.js';

const EXPECTED = {
  connectionId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
};

describe('Runtime Host connection effects protocol', () => {
  test('declares ready commands with bounded mutation errors', () => {
    assert.deepEqual(Object.keys(CONNECTION_EFFECT_OPERATION_SPECS).sort(), [
      'connection.models.fetch',
      'connection.onboarding.save',
      'connection.onboarding.verify',
      'connection.profile.models.fetch',
      'connection.profile.test.run',
      'connection.test.run',
    ]);
    for (const operation of Object.keys(CONNECTION_EFFECT_OPERATION_SPECS) as Array<
      keyof typeof CONNECTION_EFFECT_OPERATION_SPECS
    >) {
      assert.deepEqual(
        {
          mode: CONNECTION_EFFECT_OPERATION_SPECS[operation].mode,
          availability: CONNECTION_EFFECT_OPERATION_SPECS[operation].availability,
          errors: CONNECTION_EFFECT_OPERATION_SPECS[operation].errors,
        },
        {
          mode: 'command',
          availability: 'ready',
          errors: [
            'host_not_ready',
            'host_draining',
            'operation_unavailable',
            'invalid_request',
            'internal_failure',
            'persistence_failed',
            'commit_outcome_unknown',
          ],
        },
      );
    }
  });

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

  test('profile effects require an explicit profile identity and bounded model selection', () => {
    const profileTest = request('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
      modelId: 'model-1',
    });
    const defaultModelProfileTest = request('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
      modelId: null,
    });
    const profileFetch = request('connection.profile.models.fetch', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
    });
    assert.deepEqual(decodeClientFrame(profileTest), profileTest);
    assert.deepEqual(decodeClientFrame(defaultModelProfileTest), defaultModelProfileTest);
    assert.deepEqual(decodeClientFrame(profileFetch), profileFetch);

    assertInvalidRequest('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
    });
    assertInvalidRequest('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: 'x'.repeat(129),
      modelId: null,
    });
    assertInvalidRequest('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
      modelId: 'x'.repeat(1_025),
    });
    assertInvalidRequest('connection.profile.test.run', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
      modelId: null,
      secret: 'forbidden',
    });
    assertInvalidRequest('connection.profile.models.fetch', {
      connectionId: EXPECTED.connectionId,
    });
    assertInvalidRequest('connection.profile.models.fetch', {
      connectionId: EXPECTED.connectionId,
      profileId: '00000000-0000-4000-8000-00000000000a',
      profileLabel: 'smuggled metadata',
    });
  });

  test('profile effect results carry only verification outcomes and never secrets', () => {
    const profileTestCommitted = response('connection.profile.test.run', {
      kind: 'committed',
      verification: 'recorded',
      test: {
        kind: 'verified',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 12,
      },
    });
    const profileTestNotRecorded = response('connection.profile.test.run', {
      kind: 'committed',
      verification: 'not_recorded',
      test: {
        kind: 'failed',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: null,
        statusCode: 429,
        errorClass: 'provider_unavailable',
      },
    });
    const profileFetchCommitted = response('connection.profile.models.fetch', {
      kind: 'committed',
      catalogRevision: 3,
      connection: { ...EXPECTED, revision: 3 },
      verification: 'recorded',
      modelCount: 2_048,
      source: 'fetched',
      fetchedAt: 1_000,
    });
    assert.deepEqual(decodeHostFrame(profileTestCommitted), profileTestCommitted);
    assert.deepEqual(decodeHostFrame(profileTestNotRecorded), profileTestNotRecorded);
    assert.deepEqual(decodeHostFrame(profileFetchCommitted), profileFetchCommitted);

    for (const result of [
      { kind: 'rejected', reason: 'profile_not_found' },
      { kind: 'rejected', reason: 'profile_disabled' },
      { kind: 'rejected', reason: 'credential_not_configured' },
      { kind: 'superseded', changed: ['connection'] },
      { kind: 'failed', errorClass: 'timeout' },
    ]) {
      const frame = response('connection.profile.test.run', result);
      assert.deepEqual(decodeHostFrame(frame), frame);
    }

    assertInvalidResponse('connection.profile.test.run', {
      kind: 'committed',
      verification: 'recorded',
      test: {
        kind: 'verified',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 12,
        apiKey: 'leaked',
      },
    });
    assertInvalidResponse('connection.profile.test.run', {
      kind: 'committed',
      verification: 'maybe',
      test: {
        kind: 'verified',
        checkedAt: '2026-07-29T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 12,
      },
    });
    assertInvalidResponse('connection.profile.test.run', {
      kind: 'rejected',
      reason: 'connection_disabled',
      detail: 'provider body',
    });
    assertInvalidResponse('connection.profile.models.fetch', {
      kind: 'committed',
      catalogRevision: 3,
      connection: { ...EXPECTED, revision: 3 },
      verification: 'recorded',
      modelCount: 2_048,
      source: 'fetched',
      fetchedAt: 1_000,
      models: [{ id: 'secret-model-list' }],
    });
    assertInvalidResponse('connection.profile.models.fetch', {
      kind: 'rejected',
      reason: 'profile_missing',
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
