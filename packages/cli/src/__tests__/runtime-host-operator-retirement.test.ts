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
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { withRetirementCancellation } from '../runtime-host-operator-retirement.js';

test('operator stdin EOF cancels reversible retirement, not a committed result or later recovery', async () => {
  const input = new PassThrough();
  const result = withRetirementCancellation(input, async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    signal.throwIfAborted();
  });
  input.end();
  await assert.rejects(result, /retirement was cancelled/u);
  assert.equal(input.listenerCount('end'), 0);

  const committedInput = new PassThrough();
  const committed = withRetirementCancellation(committedInput, async (signal) => {
    committedInput.end();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return 'committed';
  });
  assert.equal(await committed, 'committed');
  assert.equal(committedInput.listenerCount('end'), 0);
});
