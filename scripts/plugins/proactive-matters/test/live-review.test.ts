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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4 } from 'ai/test';
import { createLiveReviewer } from '../scripts/live-review.js';

test('live reviewer forwards prompt, output budget and signal to a separate model', async () => {
  const calls: any[] = [];
  const records: any[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (input) => {
      calls.push(input);
      return {
        content: [
          { type: 'text', text: '{"approved":false,"feedback":"Missing delivery evidence"}' },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 20 }, outputTokens: { total: 10 } },
        warnings: [],
      };
    },
  });
  const signal = new AbortController().signal;
  const review = createLiveReviewer(model, 'independent-review', {
    onResult: (entry) => records.push(entry),
  });
  const result = await review({
    system: 'Review independently',
    prompt: 'Execution evidence',
    maxOutputTokens: 8192,
    signal,
  });
  assert.equal(JSON.parse(result.text).approved, false);
  assert.equal(result.modelId, 'independent-review');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxOutputTokens, 8192);
  assert.ok(calls[0].abortSignal);
  assert.ok(JSON.stringify(calls[0].prompt).includes('Execution evidence'));
  assert.equal(records.length, 1);
});
