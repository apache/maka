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
import { removeEvalWebTools } from '../provider-web-tool-surface.js';

test('Eval removes named and provider-native web tools from provider requests', () => {
  const projected = removeEvalWebTools(
    Buffer.from(
      JSON.stringify({
        model: 'deepseek-v4-flash',
        tools: [
          { type: 'function', function: { name: 'Read' } },
          { type: 'function', function: { name: 'WebSearch' } },
          { name: 'WebFetch', input_schema: {} },
          { type: 'custom', name: 'FetchURL' },
          { type: 'web_search_20250305' },
          { type: 'web_fetch_preview' },
        ],
      }),
    ),
  );

  assert.equal(projected.removed, 5);
  assert.equal(projected.model, 'deepseek-v4-flash');
  assert.deepEqual(projected.toolNames, ['Read']);
  assert.deepEqual(JSON.parse(projected.body.toString('utf8')), {
    model: 'deepseek-v4-flash',
    tools: [{ type: 'function', function: { name: 'Read' } }],
  });
});

test('Eval preserves non-JSON and requests without web tools byte-for-byte', () => {
  for (const body of [
    Buffer.from('not-json'),
    Buffer.from(JSON.stringify({ model: 'deepseek-v4-flash' })),
    Buffer.from(JSON.stringify({ tools: [{ type: 'function', function: { name: 'Read' } }] })),
  ]) {
    const projected = removeEvalWebTools(body);
    assert.equal(projected.removed, 0);
    assert.equal(projected.body, body);
  }
});
