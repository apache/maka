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

const { quietWaits, retrying, waitActivity } = await import(
  '../../../../plugins/agent/conversations/ui/runWaits.ts'
);

const waiting = (...kinds) => ({
  state: { kind: 'waiting', waits: kinds.map((kind) => ({ kind })), authorityUnavailable: false },
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

test('the process group asks for a response only for a user wait', () => {
  assert.equal(waitActivity('waiting', waiting('retry')), 'retrying');
  assert.equal(waitActivity('waiting', waiting('provider_backoff')), 'retrying');
  assert.equal(waitActivity('waiting', waiting('cell')), undefined);
  assert.equal(waitActivity('waiting', waiting('model')), undefined);
  assert.equal(waitActivity('waiting', null), undefined);
  assert.equal(waitActivity('waiting_for_user', null), 'waiting_for_user');
  assert.equal(waitActivity('waiting', waiting('retry', 'approval')), 'waiting_for_user');
  assert.equal(waitActivity('waiting', waiting('blocker')), 'waiting_for_user');
  const unavailable = waiting('retry');
  unavailable.state.authorityUnavailable = true;
  assert.equal(waitActivity('waiting', unavailable), 'waiting_for_user');
  // A pending question or tool interaction keeps the run running or in a quiet cell wait.
  assert.equal(waitActivity('running', null, true), 'waiting_for_user');
  assert.equal(waitActivity('waiting', waiting('cell'), true), 'waiting_for_user');
  assert.equal(waitActivity('idle', null, true), undefined);
  assert.equal(waitActivity('failed', null, true), undefined);
});
