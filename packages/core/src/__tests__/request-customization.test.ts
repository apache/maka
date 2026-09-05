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
import {
  normalizeRequestBodyOverlay,
  normalizeRequestHeaders,
  normalizeOptionalRequestBodyOverlay,
} from '../request-customization.js';

describe('request customization validation', () => {
  test('rejects protected and case-insensitively duplicated headers', () => {
    assert.throws(() => normalizeRequestHeaders({ Authorization: 'secret' }), /managed by Maka/);
    assert.throws(
      () => normalizeRequestHeaders({ 'X-Tenant': 'one', 'x-tenant': 'two' }),
      /Duplicate request header/,
    );
    assert.throws(() => normalizeRequestHeaders({ 'X-Title': 'Maka 中文' }), /Invalid value/);
    assert.throws(() => normalizeRequestHeaders({ 'X-Title': 'Maka\u0001' }), /Invalid value/);
    assert.doesNotThrow(() => normalizeRequestHeaders({ 'X-Title': 'Maka\tAgent' }));
    assert.throws(
      () =>
        normalizeRequestHeaders(
          Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [`X-${index}`, 'x'.repeat(8_192)]),
          ),
        ),
      /cannot exceed .* bytes/,
    );
  });

  test('accepts only safe top-level JSON objects', () => {
    assert.deepEqual(
      normalizeRequestBodyOverlay({ provider: { order: ['Anthropic'], allow_fallbacks: false } }),
      { provider: { order: ['Anthropic'], allow_fallbacks: false } },
    );
    assert.deepEqual(normalizeRequestBodyOverlay({ z: 1, nested: { z: 2, a: 1 }, a: 2 }), {
      a: 2,
      nested: { a: 1, z: 2 },
      z: 1,
    });
    assert.equal(normalizeOptionalRequestBodyOverlay({}), undefined);
    assert.throws(() => normalizeRequestBodyOverlay(['not', 'an', 'object']), /JSON object/);
    assert.throws(
      () => normalizeRequestBodyOverlay(JSON.parse('{"provider":{"__proto__":{}}}')),
      /not allowed/,
    );
  });
});
