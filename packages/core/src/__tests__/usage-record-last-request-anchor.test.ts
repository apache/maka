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
import test from 'node:test';
import { isLastRequestAnchor, isTokenUsageFields } from '../usage-record-schema.js';
import { decodeCanonicalMessage } from '../session.js';

const usage = { input: 370, output: 60 };

test('a last-request anchor accepts the new usage shape and retired payload key', () => {
  assert.equal(isLastRequestAnchor({ inputTokens: 120, outputTokens: 30 }), true);
  assert.equal(isLastRequestAnchor({ inputTokens: 120 }), true);
  assert.equal(isLastRequestAnchor({ inputTokens: 120, payloadChars: 4_000 }), true);
  assert.equal(isLastRequestAnchor({ payloadChars: 4_000 }), false);
  assert.equal(isLastRequestAnchor({ inputTokens: 0, payloadChars: 4_000 }), false);
  assert.equal(isLastRequestAnchor({ inputTokens: 120, outputTokens: -1 }), false);
  assert.equal(isLastRequestAnchor({ inputTokens: 120, foo: 1 }), false);
});

test('token-usage fields carry the anchor and reject a broken one', () => {
  assert.equal(
    isTokenUsageFields({ ...usage, lastRequestAnchor: { inputTokens: 120, outputTokens: 30 } }),
    true,
  );
  assert.equal(isTokenUsageFields(usage), true);
  assert.equal(
    isTokenUsageFields({ ...usage, lastRequestAnchor: { inputTokens: 120, payloadChars: 4_000 } }),
    true,
  );
  assert.equal(
    isTokenUsageFields({ ...usage, lastRequestAnchor: { inputTokens: 120, foo: 1 } }),
    false,
  );
  // The route the counts belong to. A reader pairs them with a window only
  // when it matches the request it is about to make.
  assert.equal(
    isTokenUsageFields({
      ...usage,
      lastRequestAnchor: { inputTokens: 120, modelId: 'm', connectionId: 'c' },
    }),
    true,
  );
});

test('an invalid anchor fails the whole token_usage message decode', () => {
  const message = {
    type: 'token_usage',
    id: 'usage-1',
    turnId: 'turn-1',
    ts: 1,
    ...usage,
  };
  assert.deepEqual(
    decodeCanonicalMessage({
      ...message,
      lastRequestAnchor: { inputTokens: 120, outputTokens: 30 },
    }),
    { ...message, lastRequestAnchor: { inputTokens: 120, outputTokens: 30 } },
  );
  assert.throws(() =>
    decodeCanonicalMessage({ ...message, lastRequestAnchor: { inputTokens: 0 } }),
  );
});
