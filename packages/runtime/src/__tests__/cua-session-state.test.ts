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
import { describe, test } from 'node:test';
import { CuaSessionState } from '../cua-session-state.js';

describe('CuaSessionState', () => {
  test('starts unobserved and a successful fresh observation makes it active', () => {
    const state = new CuaSessionState('session-1');

    assert.deepEqual(state.snapshot(), { status: 'unobserved', generation: 0 });
    assert.deepEqual(state.beforeAction(), {
      ok: false,
      reason: 'no_active_frame',
    });

    assert.deepEqual(state.freshObservationSucceeded(), {
      status: 'active',
      generation: 1,
    });
    assert.equal(state.beforeAction().ok, true);
  });

  test('physical intervention fences old leases through debounce and reobserve', () => {
    const state = new CuaSessionState('session-1');
    state.freshObservationSucceeded();
    const lease = state.beforeAction();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    assert.deepEqual(state.physicalUserIntervened(), {
      status: 'intervention_debounce',
      generation: 2,
    });
    assert.deepEqual(state.validateLease(lease.lease), {
      ok: false,
      reason: 'user_intervened',
    });
    assert.deepEqual(state.interventionDebounceElapsed(), {
      status: 'reobserve_required',
      generation: 3,
    });
    assert.deepEqual(state.beforeAction(), {
      ok: false,
      reason: 'reobserve_required',
    });

    state.freshObservationSucceeded();
    assert.equal(state.beforeAction().ok, true);
  });

  test('an event during observation fences that observation attempt', () => {
    const state = new CuaSessionState('session-1');
    const lease = state.beforeObservation();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    state.screenLocked();

    assert.deepEqual(state.validateObservationLease(lease.lease), {
      ok: false,
      reason: 'screen_locked',
    });
  });

  test('unlock requires a fresh observation before actions resume', () => {
    const state = new CuaSessionState('session-1');
    state.freshObservationSucceeded();
    const lease = state.beforeAction();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    state.screenLocked();
    assert.deepEqual(state.validateLease(lease.lease), {
      ok: false,
      reason: 'screen_locked',
    });
    assert.deepEqual(state.screenUnlocked(), {
      status: 'reobserve_required',
      generation: 3,
    });
    assert.deepEqual(state.beforeAction(), {
      ok: false,
      reason: 'reobserve_required',
    });
  });

  test('explicit reobserve requirement fences the active lease', () => {
    const state = new CuaSessionState('session-1');
    state.freshObservationSucceeded();
    const lease = state.beforeAction();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    assert.deepEqual(state.reobserveRequired(), {
      status: 'reobserve_required',
      generation: 2,
    });
    assert.deepEqual(state.validateLease(lease.lease), {
      ok: false,
      reason: 'reobserve_required',
    });
  });

  test('blocked URL and user stop remain terminal in the current CU session', () => {
    const state = new CuaSessionState('session-1');
    state.freshObservationSucceeded();

    state.blockedUrlDetected();
    assert.deepEqual(state.beforeAction(), {
      ok: false,
      reason: 'blocked_url',
    });
    state.freshObservationSucceeded();
    assert.deepEqual(state.beforeAction(), {
      ok: false,
      reason: 'blocked_url',
    });

    const stopped = new CuaSessionState('session-2');
    stopped.freshObservationSucceeded();
    stopped.userStopped();
    assert.deepEqual(stopped.beforeAction(), {
      ok: false,
      reason: 'user_stopped',
    });
    stopped.freshObservationSucceeded();
    assert.deepEqual(stopped.beforeAction(), {
      ok: false,
      reason: 'user_stopped',
    });
  });

  test('terminal states absorb later lifecycle events', () => {
    const blocked = new CuaSessionState('blocked');
    blocked.blockedUrlDetected();
    blocked.screenLocked();
    blocked.reobserveRequired();
    blocked.physicalUserIntervened();
    blocked.userStopped();
    assert.deepEqual(blocked.snapshot(), {
      status: 'blocked_url',
      generation: 1,
    });

    const stopped = new CuaSessionState('stopped');
    stopped.userStopped();
    stopped.blockedUrlDetected();
    stopped.screenLocked();
    stopped.reobserveRequired();
    stopped.physicalUserIntervened();
    assert.deepEqual(stopped.snapshot(), {
      status: 'user_stopped',
      generation: 1,
    });
  });

  test('dynamic content changes neither synthesize intervention nor fence a lease', () => {
    const state = new CuaSessionState('session-1');
    state.freshObservationSucceeded();
    const lease = state.beforeAction();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    assert.deepEqual(state.dynamicContentChanged(), {
      status: 'active',
      generation: 1,
    });
    assert.deepEqual(state.validateLease(lease.lease), {
      ok: true,
      lease: lease.lease,
    });
  });

  test('lease identity is session scoped', () => {
    const first = new CuaSessionState('session-1');
    const second = new CuaSessionState('session-2');
    first.freshObservationSucceeded();
    second.freshObservationSucceeded();
    const lease = first.beforeAction();
    assert.equal(lease.ok, true);
    if (!lease.ok) return;

    assert.deepEqual(second.validateLease(lease.lease), {
      ok: false,
      reason: 'reobserve_required',
    });
  });
});
