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
import { createOpenResponsesCompatibilityFinalizer } from '../open-responses-compatibility.js';

test('applies the declared Open Responses body policies', () => {
  const finalize = createOpenResponsesCompatibilityFinalizer('alibaba-token-plan');
  assert.ok(finalize);
  assert.deepEqual(finalize({ model: 'qwen3.8-max', store: true, tool_choice: 'auto' }), {
    model: 'qwen3.8-max',
    store: false,
    tool_choice: 'auto',
  });
  assert.deepEqual(finalize({ model: 'qwen3.8-max' }), {
    model: 'qwen3.8-max',
    store: false,
  });
  for (const toolChoice of ['required', { type: 'function', name: 'lookup' }]) {
    assert.throws(
      () => finalize({ tool_choice: toolChoice }),
      /does not support forced tool_choice/,
    );
  }
});
