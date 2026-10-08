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
import { test } from 'node:test';
import {
  providerRetryDecision,
  providerRetryReason,
  responseHeadersFromError,
  retryAfterMs,
} from '../provider-retry-policy.js';

test('retryability is determined only by the failure kind', () => {
  const expected = {
    abort: null,
    auth: null,
    context_overflow: null,
    network: 'network',
    provider_billing: null,
    provider_capacity: 'provider_capacity',
    provider_unavailable: 'provider_unavailable',
    rate_limit: 'rate_limit',
    request_rejected: null,
    stream_truncated: 'stream_truncated',
    timeout: 'timeout',
    unknown: null,
  } as const;
  for (const [kind, reason] of Object.entries(expected)) {
    assert.equal(providerRetryReason(kind as keyof typeof expected), reason, kind);
  }
});

test('response headers are normalized from records and native Headers', () => {
  assert.deepEqual(responseHeadersFromError({ responseHeaders: { 'Retry-After': '3' } }), {
    'retry-after': '3',
  });
  assert.deepEqual(
    responseHeadersFromError({ responseHeaders: new Headers({ 'Retry-After-Ms': '1250' }) }),
    { 'retry-after-ms': '1250' },
  );
  assert.deepEqual(
    responseHeadersFromError({
      responseHeaders: { 'Retry-After': '3', ignored: 4, absent: undefined },
    }),
    { 'retry-after': '3' },
  );
  for (const value of [undefined, null, false, 'error', 1, {}, { responseHeaders: null }]) {
    assert.equal(responseHeadersFromError(value), undefined);
  }
});

test('a valid Retry-After is used when Retry-After-Ms is invalid', () => {
  assert.equal(retryAfterMs({ 'retry-after-ms': 'invalid', 'retry-after': '4' }), 4_000);
  assert.equal(retryAfterMs({ 'retry-after-ms': '1250', 'retry-after': '4' }), 1_250);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '2147483648']) {
    assert.equal(retryAfterMs({ 'retry-after-ms': value }), undefined, value);
  }
  assert.equal(retryAfterMs({ 'retry-after-ms': '0.1' }), 1);
  assert.equal(retryAfterMs({ 'retry-after-ms': '2147483647' }), 2_147_483_647);
  assert.equal(retryAfterMs({ 'retry-after': '0' }), undefined);
  assert.equal(retryAfterMs({}), undefined);
});

test('HTTP-date Retry-After is measured against the current clock', () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-09-28T00:00:00.000Z');
  try {
    assert.equal(retryAfterMs({ 'retry-after': 'Mon, 28 Sep 2026 00:00:04 GMT' }), 4_000);
    assert.equal(retryAfterMs({ 'retry-after': 'Sun, 27 Sep 2026 23:59:59 GMT' }), undefined);
  } finally {
    Date.now = originalNow;
  }
});

test('retry decision keeps retryability and server delay together', () => {
  assert.deepEqual(
    providerRetryDecision('rate_limit', { 'retry-after-ms': 'invalid', 'retry-after': '4' }),
    { reason: 'rate_limit', retryAfterMs: 4_000 },
  );
  assert.deepEqual(providerRetryDecision('provider_billing', { 'retry-after': '4' }), {
    reason: null,
  });
  assert.deepEqual(providerRetryDecision('network'), { reason: 'network' });
});
