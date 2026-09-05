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

// Behavior contract for the Computer Use screen-lock monitor. Driven against
// injected signals (no Electron main process), because the whole point of the
// monitor is that neither macOS signal is trustworthy alone:
//  - events know transitions but not the state at startup
//  - the point-in-time query can be asked any time but has blind spots
//  - and their union must not be able to wedge Computer Use permanently
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createComputerUseScreenLockGuard,
  createScreenLockMonitor,
  withComputerUseScreenLock,
  type ScreenIdleState,
} from '../computer-use/screen-lock.js';

function makeMonitor(initial: ScreenIdleState = 'active') {
  let state: ScreenIdleState | undefined = initial;
  let probeThrows = false;
  let subscribeThrows = false;
  const handlers: { onLock?: () => void; onUnlock?: () => void } = {};
  let subscribed = 0;
  let unsubscribed = 0;
  const monitor = createScreenLockMonitor({
    subscribe: ({ onLock, onUnlock }) => {
      if (subscribeThrows) throw new Error('powerMonitor unavailable');
      subscribed += 1;
      handlers.onLock = onLock;
      handlers.onUnlock = onUnlock;
      return () => {
        unsubscribed += 1;
      };
    },
    probe: () => {
      if (probeThrows) throw new Error('probe unavailable');
      return state;
    },
  });
  return {
    monitor,
    /** Nothing is subscribed until the first probe, so open the subscription. */
    start: () => monitor.locked(),
    lock: () => handlers.onLock?.(),
    unlock: () => handlers.onUnlock?.(),
    setState: (next: ScreenIdleState | undefined) => {
      state = next;
    },
    setProbeThrows: (value: boolean) => {
      probeThrows = value;
    },
    setSubscribeThrows: (value: boolean) => {
      subscribeThrows = value;
    },
    subscribedCount: () => subscribed,
    unsubscribedCount: () => unsubscribed,
  };
}

test('nothing is subscribed until the first probe', () => {
  // Tool assembly runs at module load, before `app.whenReady()`, and
  // `powerMonitor` cannot be touched before that. The first `locked()` call
  // comes with the first dispatch, which is long after ready.
  const { monitor, subscribedCount } = makeMonitor('active');
  assert.equal(subscribedCount(), 0);
  monitor.locked();
  assert.equal(subscribedCount(), 1);
  monitor.locked();
  assert.equal(subscribedCount(), 1);
});

test('a platform with nothing to subscribe to still answers', () => {
  const { monitor, setSubscribeThrows, setState } = makeMonitor('active');
  setSubscribeThrows(true);
  assert.equal(monitor.locked(), false);
  setState('locked');
  assert.equal(monitor.locked(), true);
});

test('an unlocked machine reads as unlocked', () => {
  const { monitor } = makeMonitor('active');
  assert.equal(monitor.locked(), false);
});

test('the point-in-time query alone answers for a process that never saw the lock', () => {
  // The case the events cannot cover: the app started while already locked, so
  // no `lock-screen` was ever delivered to it.
  const { monitor } = makeMonitor('locked');
  assert.equal(monitor.locked(), true);
});

test('the lock event alone answers when the query cannot', () => {
  // The mirror case: a platform whose query returns 'unknown', where the
  // transition events are the only signal there is.
  const probe = makeMonitor('unknown');
  assert.equal(probe.monitor.locked(), false);
  probe.lock();
  assert.equal(probe.monitor.locked(), true);
  probe.unlock();
  assert.equal(probe.monitor.locked(), false);
});

test('a query with no answer at all falls back to the events', () => {
  const { monitor, lock, setState } = makeMonitor('active');
  setState(undefined);
  assert.equal(monitor.locked(), false);
  lock();
  assert.equal(monitor.locked(), true);
});

test('an authoritative unlocked answer clears a latched lock event', () => {
  // Without this, a platform that delivered `lock-screen` and then never
  // delivered `unlock-screen` would disable Computer Use until the app
  // restarted. The query is the way out.
  const { monitor, start, lock, setState } = makeMonitor('locked');
  start();
  lock();
  assert.equal(monitor.locked(), true);
  setState('active');
  assert.equal(monitor.locked(), false);
  // And it stays cleared once the query goes quiet again.
  setState('unknown');
  assert.equal(monitor.locked(), false);
});

test('a throwing probe falls back to the events rather than reporting unlocked', () => {
  const { monitor, start, lock, setProbeThrows } = makeMonitor('active');
  start();
  lock();
  setProbeThrows(true);
  assert.equal(monitor.locked(), true);
});

test('idle is not locked', () => {
  // A machine left alone long enough to dim is still a machine the user can
  // see and take back. Only an actual lock ends the session.
  const { monitor } = makeMonitor('idle');
  assert.equal(monitor.locked(), false);
});

test('dispose unsubscribes and stops reporting', () => {
  const { monitor, unsubscribedCount, setState } = makeMonitor('locked');
  assert.equal(monitor.locked(), true);
  monitor.dispose();
  assert.equal(unsubscribedCount(), 1);
  assert.equal(monitor.locked(), false);
  setState('locked');
  assert.equal(monitor.locked(), false);
  monitor.dispose();
  assert.equal(unsubscribedCount(), 1);
});

function makeGuard() {
  const released: string[] = [];
  const handlers: { onLock?: () => void; onUnlock?: () => void } = {};
  const guard = createComputerUseScreenLockGuard({
    subscribe: ({ onLock, onUnlock }) => {
      handlers.onLock = onLock;
      handlers.onUnlock = onUnlock;
      return () => {};
    },
    probe: () => 'unknown',
  });
  guard.setSessionEvents({
    screenUnlocked: (sessionId: string) => {
      released.push(sessionId);
    },
  });
  // The guard subscribes lazily, on its first probe, exactly as the first
  // dispatch would make it.
  guard.locked();
  return { guard, released, lock: () => handlers.onLock?.(), unlock: () => handlers.onUnlock?.() };
}

test('unlocking releases every session that tried to drive the machine', () => {
  // Without this the refusal is one-way: `screen_locked` is the only session
  // state whose exit is an explicit call, and nothing used to make it.
  const { guard, released, lock, unlock } = makeGuard();
  guard.noteSessionActive('s1');
  guard.noteSessionActive('s2');
  lock();
  assert.equal(guard.locked(), true);
  unlock();
  assert.deepEqual(released.sort(), ['s1', 's2']);
  assert.equal(guard.locked(), false);
});

test('a stopped session is not released', () => {
  const { guard, released, lock, unlock } = makeGuard();
  guard.noteSessionActive('s1');
  guard.noteSessionActive('s2');
  guard.clearForSession('s1');
  lock();
  unlock();
  assert.deepEqual(released, ['s2']);
});

test('the overlay hook registers a session that dispatched, which is the executor-refusal path', () => {
  // This test used to be named "including a refused action" and its comment
  // said `onActionBegin` runs before the backend sees the action, so the
  // refused attempt was itself what earned the release. It proved nothing of
  // the kind — it calls `onActionBegin` directly — and the claim is false: the
  // host-probe refusal returns from the tool long before `runWithPresentation`,
  // which is `onActionBegin`'s only call site. See the gate test in
  // packages/runtime, which asks the real tool and finds `onActionBegin`
  // never ran.
  //
  // What this hook actually covers is the other producer, and it is the only
  // thing that does: the host's probe says unlocked, the dispatch goes
  // through, and the executor comes back with a `screen_locked` outcome. That
  // session latched the state from `applyTypedOutcomeState`, and nothing but
  // this registration would ever release it.
  const { guard, released, lock, unlock } = makeGuard();
  const seen: string[] = [];
  const hook = withComputerUseScreenLock(
    {
      onActionBegin: (_action, context) => {
        seen.push(context.sessionId);
      },
    },
    guard,
  );
  hook.onActionBegin({ type: 'screenshot' }, { sessionId: 's9', toolCallId: 'c1' });
  lock();
  unlock();
  assert.deepEqual(seen, ['s9']);
  assert.deepEqual(released, ['s9']);
});

test('disposing the guard forgets its sessions', () => {
  const { guard, released, lock, unlock } = makeGuard();
  guard.noteSessionActive('s1');
  guard.dispose();
  lock();
  unlock();
  assert.deepEqual(released, []);
});
