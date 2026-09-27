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
  assert.equal(providerRetryReason('rate_limit'), 'rate_limit');
  assert.equal(providerRetryReason('provider_billing'), null);
});

test('response headers are normalized from records and native Headers', () => {
  assert.deepEqual(responseHeadersFromError({ responseHeaders: { 'Retry-After': '3' } }), {
    'retry-after': '3',
  });
  assert.deepEqual(
    responseHeadersFromError({ responseHeaders: new Headers({ 'Retry-After-Ms': '1250' }) }),
    { 'retry-after-ms': '1250' },
  );
});

test('a valid Retry-After is used when Retry-After-Ms is invalid', () => {
  assert.equal(retryAfterMs({ 'retry-after-ms': 'invalid', 'retry-after': '4' }), 4_000);
  assert.equal(retryAfterMs({ 'retry-after-ms': '1250', 'retry-after': '4' }), 1_250);
  assert.equal(retryAfterMs({ 'retry-after': '0' }), undefined);
});

test('retry decision keeps retryability and server delay together', () => {
  assert.deepEqual(
    providerRetryDecision('rate_limit', { 'retry-after-ms': 'invalid', 'retry-after': '4' }),
    { reason: 'rate_limit', retryAfterMs: 4_000 },
  );
  assert.deepEqual(providerRetryDecision('provider_billing', { 'retry-after': '4' }), {
    reason: null,
  });
});
