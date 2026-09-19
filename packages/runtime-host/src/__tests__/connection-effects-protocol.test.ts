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
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';

const EXPECTED = {
  connectionId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
};

describe('Runtime Host connection effects protocol', () => {
  test('read-only model previews have a bounded typed wire contract', () => {
    const input = request('connection.models.fetch', {
      connectionId: EXPECTED.connectionId,
      preview: true,
    });
    assert.deepEqual(decodeClientFrame(input), input);
    assertInvalidRequest('connection.models.fetch', {
      connectionId: EXPECTED.connectionId,
      preview: false,
    });
    const result = response('connection.models.fetch', {
      kind: 'preview',
      fetchedAt: 1234,
      models: [
        {
          id: 'sol:max',
          trae: {
            configName: 'sol',
            modelName: 'sol__max',
            mode: 'max',
            reasoningEfforts: ['xhigh'],
            toolResponseImages: false,
            loadPercent: 174,
          },
        },
      ],
    });
    assert.deepEqual(decodeHostFrame(result), result);
    assert.throws(
      () =>
        decodeHostFrame(
          response('connection.models.fetch', {
            kind: 'preview',
            fetchedAt: 1234,
            models: Array.from({ length: 2049 }, () => ({ id: 'model' })),
          }),
        ),
      RuntimeHostProtocolError,
    );
  });

  test('bounds transient onboarding secrets, models, and save selections', () => {
    const verify = request('connection.onboarding.verify', {
      target: { kind: 'create', providerType: 'openrouter' },
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    const save = request('connection.onboarding.save', {
      target: {
        kind: 'existing',
        connectionId: '00000000-0000-4000-8000-000000000002',
      },
      apiKey: 'transient-secret',
      baseUrl: 'https://relay.example.test/v1',
      enabledModelIds: ['relay/model'],
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
      decodeHostFrame(
        response('connection.onboarding.save', {
          kind: 'saved',
          connection: {
            connectionId: '00000000-0000-4000-8000-000000000002',
            revision: 2,
            slug: 'relay-2',
            providerType: 'openai-compatible',
          },
        }),
      ),
      response('connection.onboarding.save', {
        kind: 'saved',
        connection: {
          connectionId: '00000000-0000-4000-8000-000000000002',
          revision: 2,
          slug: 'relay-2',
          providerType: 'openai-compatible',
        },
      }),
    );
    // A save whose discovery basis was concurrently changed is superseded.
    assert.deepEqual(
      decodeHostFrame(
        response('connection.onboarding.save', { kind: 'rejected', reason: 'superseded' }),
      ),
      response('connection.onboarding.save', { kind: 'rejected', reason: 'superseded' }),
    );
    const adoptAllDiscovered = request('connection.onboarding.save', {
      target: { kind: 'create', providerType: 'openrouter' },
      apiKey: 'transient-secret',
      baseUrl: null,
      enabledModelIds: [],
    });
    assert.deepEqual(decodeClientFrame(adoptAllDiscovered), adoptAllDiscovered);
    // Provider-specific URL semantics are resolved after an existing target's
    // canonical provider is loaded; the wire still bounds the raw value.
    assertInvalidRequest('connection.onboarding.verify', {
      target: { kind: 'create', providerType: 'openai-compatible' },
      apiKey: 'transient-secret',
      baseUrl: 'x'.repeat(2_049),
    });
    assertInvalidRequest('connection.onboarding.verify', {
      providerType: 'openai-compatible',
      connectionId: null,
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    assertInvalidRequest('connection.onboarding.verify', {
      target: {
        kind: 'existing',
        connectionId: 42,
      },
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    // A create target may carry a caller-chosen slug/name (#4605); both
    // decode through the same catalog codecs as the rest of the wire.
    const namedVerify = request('connection.onboarding.verify', {
      target: { kind: 'create', providerType: 'openrouter', slug: 'openrouter-work', name: 'Work' },
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    assert.deepEqual(decodeClientFrame(namedVerify), namedVerify);
    // …but a malformed requested slug fails decode like any other bad input.
    assertInvalidRequest('connection.onboarding.verify', {
      target: { kind: 'create', providerType: 'openrouter', slug: 'NOT A SLUG' },
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    // …and the create target stays closed to fields it does not define.
    assertInvalidRequest('connection.onboarding.verify', {
      target: { kind: 'create', providerType: 'openai-compatible', slug2: 'surface-owned' },
      apiKey: 'transient-secret',
      baseUrl: null,
    });
    // slug_taken is the create target's collision answer, on both halves.
    assert.deepEqual(
      decodeHostFrame(
        response('connection.onboarding.verify', { kind: 'rejected', reason: 'slug_taken' }),
      ),
      response('connection.onboarding.verify', { kind: 'rejected', reason: 'slug_taken' }),
    );
    assert.deepEqual(
      decodeHostFrame(
        response('connection.onboarding.save', { kind: 'rejected', reason: 'slug_taken' }),
      ),
      response('connection.onboarding.save', { kind: 'rejected', reason: 'slug_taken' }),
    );
    assertInvalidResponse('connection.onboarding.verify', {
      kind: 'verified',
      models: [],
    });
    assertInvalidResponse('connection.onboarding.save', {
      kind: 'failed',
      errorClass: 'auth',
      secret: 'forbidden',
    });
    assertInvalidResponse('connection.onboarding.save', {
      kind: 'saved',
      connection: {
        connectionId: '00000000-0000-4000-8000-000000000002',
        revision: 0,
        slug: 'relay-2',
        providerType: 'openai-compatible',
      },
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
  test('keeps one exact and bounded connection usage report', () => {
    const report = response('connection.usage.read', {
      kind: 'report',
      report: {
        accountLabel: 'joob1nhk13d9',
        planLabel: 'Go',
        stats: {
          requests: 3552,
          failed: 5,
          successRate: 99.86,
          cost: 5.85,
          tokensIn: 428_987_308,
          tokensOut: 2_971_687,
        },
        windows: [
          {
            id: 'fiveHour',
            label: null,
            used: 0.25,
            cap: 3,
            unit: 'credits',
            resetsAt: 1_789_746_210_944,
            unlimited: null,
          },
          {
            id: 'weekly',
            label: 'Weekly',
            used: 0.38,
            cap: 6,
            unit: 'credits',
            resetsAt: null,
            unlimited: true,
          },
        ],
        periodEnd: 1_790_310_000_000,
        partiallyUnauthorized: false,
        fetchedAt: 1_789_000_000_000,
      },
    });
    assert.deepEqual(decodeHostFrame(report), report);

    // Read-only: the only non-report shapes are an explicit unavailability and
    // a rejection. A committed/superseded shape has no meaning here.
    const unavailable = response('connection.usage.read', {
      kind: 'unavailable',
      reason: 'unsupported',
    });
    assert.deepEqual(decodeHostFrame(unavailable), unavailable);
    const rejected = response('connection.usage.read', {
      kind: 'rejected',
      reason: 'credential_not_configured',
    });
    assert.deepEqual(decodeHostFrame(rejected), rejected);

    assertInvalidResponse('connection.usage.read', {
      kind: 'report',
      report: {
        accountLabel: null,
        planLabel: null,
        stats: null,
        windows: [
          {
            id: 'w',
            label: null,
            used: -1,
            cap: 1,
            unit: 'credits',
            resetsAt: null,
            unlimited: null,
          },
        ],
        periodEnd: null,
        fetchedAt: 1,
      },
    });
    assertInvalidResponse('connection.usage.read', {
      kind: 'unavailable',
      reason: 'made-up',
    });
    // `unauthorized` is an accepted reason: a rejected credential is reported as
    // itself, not folded into `network`.
    const unauthorized = response('connection.usage.read', {
      kind: 'unavailable',
      reason: 'unauthorized',
    });
    assert.deepEqual(decodeHostFrame(unauthorized), unauthorized);
    // The window array is capped like every other array in this package.
    assertInvalidResponse('connection.usage.read', {
      kind: 'report',
      report: {
        accountLabel: null,
        planLabel: null,
        stats: null,
        windows: Array.from({ length: 32 }, (_unused, index) => ({
          id: `w-${index}`,
          label: null,
          used: 1,
          cap: 2,
          unit: 'credits',
          resetsAt: null,
          unlimited: null,
        })),
        periodEnd: null,
        partiallyUnauthorized: false,
        fetchedAt: 1,
      },
    });
    assertInvalidResponse('connection.usage.read', {
      kind: 'report',
      report: {
        accountLabel: null,
        planLabel: null,
        stats: null,
        windows: [
          {
            id: 'w',
            label: null,
            used: 1,
            cap: 1,
            unit: 'bananas',
            resetsAt: null,
            unlimited: null,
          },
        ],
        periodEnd: null,
        fetchedAt: 1,
      },
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
