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

/**
 * Behavioral coverage for the framework-free primitives behind
 * useOAuthLoginFlow — the shared browser-loopback login controller that both
 * the OAuth catalog modals and the model connection detail sheet's 重新登录
 * button drive.
 *
 * The hook itself needs a DOM + React to render; these primitives are pulled
 * out precisely so the two safety behaviors the task cares about — the
 * pending-action guard (a second concurrent login/logout is rejected) and
 * cancel-on-unmount (a still-open authorization request is cancelled and not
 * re-cancelled) — are testable directly, without a renderer.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createOneShotActionGuard,
  teardownPendingAuthorization,
} from '../../renderer/settings/oauth-login-flow-guard.js';

describe('useOAuthLoginFlow pending-action guard', () => {
  it('admits the first action and rejects a concurrent second one', () => {
    const guard = createOneShotActionGuard<'login' | 'logout'>();
    assert.equal(guard.current, null);
    assert.equal(guard.begin('login'), true, 'first login must be admitted');
    assert.equal(guard.current, 'login');
    // A double-click / a logout racing the in-flight login must be rejected
    // synchronously, before React re-renders the disabled button.
    assert.equal(guard.begin('login'), false, 'a second login must be rejected while one is pending');
    assert.equal(guard.begin('logout'), false, 'a racing logout must be rejected while login is pending');
    assert.equal(guard.current, 'login', 'the rejected action must not overwrite the pending one');
  });

  it('re-admits an action only after the pending one finishes', () => {
    const guard = createOneShotActionGuard<'login' | 'logout'>();
    assert.equal(guard.begin('login'), true);
    guard.finish();
    assert.equal(guard.current, null, 'finish must clear the pending action');
    assert.equal(guard.begin('logout'), true, 'a new action is admitted once the previous one finished');
    assert.equal(guard.current, 'logout');
  });
});

describe('useOAuthLoginFlow cancel-on-unmount', () => {
  it('cancels a still-pending authorization request and clears the holder', () => {
    const holder: { current: string | null } = { current: 'auth-req-123' };
    const cancelled: string[] = [];
    teardownPendingAuthorization(holder, (id) => cancelled.push(id));
    assert.deepEqual(cancelled, ['auth-req-123'], 'the pending authorization request must be cancelled');
    assert.equal(holder.current, null, 'the holder must be cleared so a late resolution cannot re-cancel');
  });

  it('does nothing when no authorization request is pending', () => {
    const holder: { current: string | null } = { current: null };
    let calls = 0;
    teardownPendingAuthorization(holder, () => { calls += 1; });
    assert.equal(calls, 0, 'no pending request means no cancellation call');
    assert.equal(holder.current, null);
  });

  it('clears the holder before cancelling so re-entrancy cannot double-cancel', () => {
    const holder: { current: string | null } = { current: 'auth-req-777' };
    const cancelled: string[] = [];
    teardownPendingAuthorization(holder, (id) => {
      // If teardown cleared the holder AFTER calling cancel, a re-entrant
      // teardown here would see the same id and cancel it twice.
      cancelled.push(id);
      teardownPendingAuthorization(holder, (again) => cancelled.push(again));
    });
    assert.deepEqual(cancelled, ['auth-req-777'], 'the request must be cancelled exactly once');
  });
});
