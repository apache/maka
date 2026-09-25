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
import { fixture } from './terminal-transcript-harness.mjs';

test('behavior input policy is explicit immutable registration data and preparation stays unchanged', async () => {
  const f = await fixture({}, async (ctx) => {
    await ctx.behaviors.register('ordinary', () => ({ instructions: 'ordinary' }));
    const options = { nativeInput: 'native_user_messages' };
    await ctx.behaviors.register('managed', () => ({ instructions: 'managed' }), options);
    options.nativeInput = 'denied';
  });
  assert.deepEqual(
    Array.from(f.registrations, ({ name, nativeInput }) => [name, nativeInput]),
    [
      ['ordinary', 'denied'],
      ['managed', 'native_user_messages'],
    ],
  );
  assert.equal((await f.invoke('managed', { session: {} })).instructions, 'managed');
  assert.equal(
    f.operations.length,
    0,
    'registration opt-in does not acquire authority or submit input',
  );
});

test('invalid behavior input policy is rejected before a declaration is published', async () => {
  await assert.rejects(
    fixture({}, async (ctx) => {
      await ctx.behaviors.register('invalid', () => ({}), { nativeInput: 'unrestricted' });
    }),
    /Invalid native input policy/,
  );
});
