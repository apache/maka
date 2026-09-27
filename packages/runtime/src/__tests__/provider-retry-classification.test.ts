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
import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';

import {
  classifyError,
  providerFailureDiagnostic,
  providerModelFailure,
} from '../provider-error-classification.js';
import type { ModelFailureKind } from '../model-protocol.js';

const providerError = (message: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name: 'AI_APICallError', ...fields });

const assertRetryProjection = (error: unknown, kind: ModelFailureKind, retryable: boolean) => {
  assert.equal(classifyError(error), kind);
  assert.equal(providerModelFailure(error).retryable, retryable);
  assert.equal(providerFailureDiagnostic(error).retryable, retryable);
};

describe('Provider retry classification', () => {
  test('derives retryability from the classified failure kind', () => {
    const cases: Array<[string, unknown, ModelFailureKind, boolean]> = [
      [
        'websocket transport',
        Object.assign(new Error('closed before completion'), {
          name: 'OpenAiResponsesTransportError',
          code: 'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
        }),
        'network',
        true,
      ],
      [
        'missing continuation',
        Object.assign(new Error('continuation unavailable'), {
          name: 'OpenAiResponsesTransportError',
          code: 'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
        }),
        'network',
        true,
      ],
      [
        'provider capacity',
        providerError('model is at capacity', { data: { error: { code: 'resource-exhausted' } } }),
        'provider_capacity',
        true,
      ],
      [
        'upstream 503',
        providerError('service unavailable', { statusCode: 503 }),
        'provider_unavailable',
        true,
      ],
      [
        'bare 429',
        providerError('temporarily unavailable', {
          statusCode: 429,
          data: { error: { code: 'rate_limit_error' } },
        }),
        'rate_limit',
        true,
      ],
      [
        'truncated stream',
        new Error('response stream ended without a finish reason'),
        'stream_truncated',
        true,
      ],
      [
        'stream timeout',
        Object.assign(new Error('model stream stalled'), { code: 'MODEL_STREAM_TIMEOUT' }),
        'timeout',
        true,
      ],
      ['fetch timeout', new DOMException('request timed out', 'TimeoutError'), 'timeout', true],
      [
        'invalid key',
        providerError('Invalid API key provided', { statusCode: 401 }),
        'auth',
        false,
      ],
      [
        'exhausted quota',
        providerError('request failed', {
          statusCode: 429,
          data: { error: { code: 'insufficient_quota' } },
        }),
        'provider_billing',
        false,
      ],
      [
        'input overflow',
        providerError('bad request', {
          statusCode: 400,
          data: { error: { code: 'context_length_exceeded' } },
        }),
        'context_overflow',
        false,
      ],
      [
        'conflict',
        providerError('conflict', { statusCode: 409, isRetryable: true }),
        'request_rejected',
        false,
      ],
      ['bad request', providerError('bad request', { statusCode: 400 }), 'request_rejected', false],
      ['fetch failure', new TypeError('fetch failed'), 'network', true],
      [
        'unclassifiable',
        { type: 'invalid_request_error', message: 'missing required field' },
        'unknown',
        false,
      ],
    ];

    for (const [label, error, kind, retryable] of cases) {
      assertRetryProjection(error, kind, retryable);
      assert.equal(providerModelFailure(error).kind, kind, label);
    }
  });

  test('uses Retry-After only as a delay hint', () => {
    const cases: Array<[string, Record<string, string> | undefined, number | undefined]> = [
      ['seconds', { 'retry-after': '40' }, 40_000],
      ['milliseconds', { 'retry-after-ms': '1500' }, 1_500],
      ['fallback', { 'retry-after-ms': 'invalid', 'retry-after': '4' }, 4_000],
      ['malformed', { 'retry-after': 'not-a-delay' }, undefined],
      ['elapsed date', { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, undefined],
      ['absent', undefined, undefined],
    ];

    for (const statusCode of [429, 503]) {
      for (const [label, responseHeaders, retryAfterMs] of cases) {
        const failure = providerModelFailure(
          providerError('provider rejected the request', { statusCode, responseHeaders }),
        );
        assert.equal(failure.retryable, true, `${statusCode} ${label}`);
        assert.equal(failure.retryAfterMs, retryAfterMs, `${statusCode} ${label}`);
      }
    }

    const refused = providerError('Invalid API key provided', {
      statusCode: 401,
      responseHeaders: { 'retry-after': '40' },
    });
    assert.equal(providerModelFailure(refused).retryable, false);
    assert.equal(providerModelFailure(refused).retryAfterMs, undefined);
  });

  test('reads Retry-After from Headers without changing retryability', () => {
    const failure = providerModelFailure(
      providerError('provider rejected the request', {
        statusCode: 429,
        responseHeaders: new Headers({ 'Retry-After': '3' }),
      }),
    );
    assert.equal(failure.retryable, true);
    assert.equal(failure.retryAfterMs, 3_000);
  });

  test('abort and exhausted Codex edge budgets override transient kinds', () => {
    const aborted = new RetryError({
      message: 'Retry stopped',
      reason: 'abort',
      errors: [Object.assign(new Error('Service unavailable'), { statusCode: 503 })],
    });
    assertRetryProjection(aborted, 'abort', false);

    const exhaustedEdge = Object.assign(
      new Error('Codex OAuth request failed: HTTP 403 Request rejected'),
      {
        name: 'OpenAiCodexEdgeRejectionError',
        statusCode: 403,
        data: { error: { code: 'openai_codex_edge_rejection' } },
        responseHeaders: { 'retry-after': '40' },
      },
    );
    assert.equal(classifyError(exhaustedEdge), 'provider_unavailable');
    assert.equal(providerModelFailure(exhaustedEdge).retryable, false);
    assert.equal(providerModelFailure(exhaustedEdge).retryAfterMs, undefined);
  });

  test('treats an exhausted free tier on 429 as billing', () => {
    const freeUsageLimit = providerError('Rate limit exceeded', {
      statusCode: 429,
      data: { error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' } },
    });
    assertRetryProjection(freeUsageLimit, 'provider_billing', false);
  });

  test('keeps retry metadata consistent for 2xx response interruptions', () => {
    for (const statusCode of [200, 201, 204, 206, 299]) {
      for (const code of [
        'ECONNRESET',
        'EPIPE',
        'ETIMEDOUT',
        'ECONNABORTED',
        'UND_ERR_SOCKET',
        'UND_ERR_BODY_TIMEOUT',
      ]) {
        const failure = new APICallError({
          message: 'Failed to process successful response',
          url: 'https://provider.invalid',
          requestBodyValues: {},
          statusCode,
          responseHeaders: { 'x-request-id': 'request-5656' },
          cause: new TypeError('terminated', {
            cause: Object.assign(new Error('connection closed'), { code }),
          }),
        });
        assert.equal(classifyError(failure), 'network');
        assert.equal(providerModelFailure(failure).retryable, true);
        assert.equal(providerFailureDiagnostic(failure).retryable, true);
      }
    }
  });
});
