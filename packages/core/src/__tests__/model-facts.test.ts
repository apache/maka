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
import { decodeModelFactsDocument, modelFactKey } from '../model-facts.js';

test('malformed and unknown model fact fields are rejected', () => {
  assert.throws(() =>
    decodeModelFactsDocument({ schemaVersion: 1, overrides: { 'openai:o4-mini': {} } }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({ schemaVersion: 1, overrides: { 'openai:o4-mini': { nope: true } } }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({ schemaVersion: 1, overrides: { 'o4-mini': { contextWindow: 1 } } }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'openai:o4-mini': { contextWindow: 0 } },
    }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'openai:o4-mini': { capabilities: { toString: true } } },
    }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'toString:model': { contextWindow: 1 } },
    }),
  );
});

test('model fact keys preserve colons in provider model ids', () => {
  const key = modelFactKey('ollama-cloud', 'gpt-oss:120b');
  assert.equal(key, 'ollama-cloud:gpt-oss:120b');
  const document = decodeModelFactsDocument({
    schemaVersion: 1,
    overrides: { [key]: { contextWindow: 131_072 } },
  });
  assert.equal(document.overrides[key]?.contextWindow, 131_072);
});
