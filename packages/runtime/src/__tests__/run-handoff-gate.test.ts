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
import { RunHandoffGate } from '../run-handoff-gate.js';

test('handoff cancellation leaves the same execution free to continue', async () => {
  for (const atBoundary of [false, true]) {
    const gate = new RunHandoffGate();
    const cancel = new AbortController();
    const request = gate.request(cancel.signal);
    assert.equal(request.commit(), false, 'a request is not a checkpoint');
    const boundary = atBoundary ? gate.reachBoundary(new AbortController().signal) : undefined;
    if (atBoundary) assert.equal(await request.ready, true);
    cancel.abort();
    assert.equal(request.commit(), false);
    assert.equal(await request.ready, atBoundary);
    if (boundary) assert.equal(await boundary, 'continue');
    assert.equal(await gate.reachBoundary(new AbortController().signal), 'continue');
  }
});

test('only the held boundary can commit and stale cancellation cannot release a later reservation', async () => {
  const gate = new RunHandoffGate();
  const first = gate.request(new AbortController().signal);
  const firstBoundary = gate.reachBoundary(new AbortController().signal);
  assert.equal(await first.ready, true);
  first.cancel();
  assert.equal(await firstBoundary, 'continue');
  const second = gate.request(new AbortController().signal);
  const secondBoundary = gate.reachBoundary(new AbortController().signal);
  assert.equal(await second.ready, true);
  first.cancel();
  assert.equal(first.commit(), false);
  assert.equal(second.commit(), true);
  second.cancel();
  assert.equal(await secondBoundary, 'pause');
  assert.equal(second.commit(), false);
});

test('user Stop releases a paused boundary and natural completion resolves a pending request', async () => {
  const gate = new RunHandoffGate();
  const execution = new AbortController();
  const request = gate.request(new AbortController().signal);
  const boundary = gate.reachBoundary(execution.signal);
  assert.equal(await request.ready, true);
  execution.abort();
  assert.equal(await boundary, 'continue');
  assert.equal(request.commit(), false);
  const pending = gate.request(new AbortController().signal);
  gate.close();
  assert.equal(await pending.ready, false);
  assert.equal(await gate.request(new AbortController().signal).ready, false);
});
