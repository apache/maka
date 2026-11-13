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

const { quietWaits, retrying } = await import(
  '../../../../plugins/agent/conversations/ui/runWaits.ts'
);

const waiting = (...kinds) => ({
  state: { kind: 'waiting', waits: kinds.map((kind) => ({ kind })) },
});

test('a run waiting to retry the provider is still at work', () => {
  assert.deepEqual(quietWaits(waiting('provider_backoff')), ['provider_backoff']);
  assert.equal(retrying(quietWaits(waiting('provider_backoff'))), true);
  assert.equal(retrying(quietWaits(waiting('retry'))), true);
});

test('a code cell or a child run keeps the run at work without saying it retries', () => {
  assert.deepEqual(quietWaits(waiting('cell', 'child')), ['cell', 'child']);
  assert.equal(retrying(quietWaits(waiting('cell', 'child'))), false);
});

test('a run that needs the person is not quietly at work', () => {
  assert.deepEqual(quietWaits(waiting('approval')), []);
  assert.deepEqual(quietWaits(waiting('provider_backoff', 'blocker')), []);
});

test('a run that is not waiting has no quiet waits', () => {
  assert.deepEqual(quietWaits(null), []);
  assert.deepEqual(quietWaits({ state: { kind: 'running' } }), []);
  assert.deepEqual(quietWaits(waiting()), []);
});
