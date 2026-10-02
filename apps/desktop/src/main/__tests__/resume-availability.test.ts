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
import { describe, it } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { createResumeAvailabilityTracker } from '../../renderer/application/contracts/resume-availability.js';

type Availability = Array<readonly [string, boolean]>;

function track(
  query: (sessionId: string) => Promise<{ readonly disposition: 'ready' | 'parked' }>,
  availability: Availability,
) {
  return createResumeAvailabilityTracker({
    query,
    onAvailability: (sessionId, available) => {
      availability.push([sessionId, available]);
    },
  });
}

/** Lets the tracker's fire-and-forget promises settle without faking timers. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe('resume availability tracker', () => {
  it('offers resume for a ready plan and hides it for a parked one', async () => {
    const availability: Availability = [];
    const dispositions = ['ready', 'parked'] as const;
    const tracker = track(
      async (sessionId) => ({ disposition: dispositions[sessionId === 'session-ready' ? 0 : 1] }),
      availability,
    );

    tracker.request('session-ready');
    tracker.request('session-parked');
    await flush();

    assert.deepEqual(availability, [
      ['session-ready', true],
      ['session-parked', false],
    ]);
  });

  it('fails closed when the plan read rejects', async () => {
    const availability: Availability = [];
    const tracker = track(async () => {
      throw new Error('host not ready');
    }, availability);

    tracker.request('session-1');
    await flush();

    assert.deepEqual(availability, [['session-1', false]]);
  });

  it('drops a stale answer that lands after the click already settled the session', async () => {
    const availability: Availability = [];
    const pending = deferred<{ readonly disposition: 'ready' | 'parked' }>();
    const tracker = track(() => pending.promise, availability);

    tracker.request('session-1');
    // The click's own answer is newer than any read still in flight.
    tracker.settle('session-1', false);
    pending.resolve({ disposition: 'ready' });
    await flush();

    assert.deepEqual(availability, [['session-1', false]]);
  });

  it('coalesces an event burst into one trailing read with the latest answer', async () => {
    const availability: Availability = [];
    const gate = deferred<void>();
    let queries = 0;
    const tracker = track(
      async () => {
        queries += 1;
        await gate.promise;
        return { disposition: 'ready' as const };
      },
      availability,
    );

    tracker.request('session-1');
    tracker.request('session-1');
    tracker.request('session-1');
    gate.resolve();
    await flush();

    assert.equal(queries, 2);
    assert.deepEqual(availability, [
      ['session-1', true],
      // The trailing read retracts the visible offer while it re-asks, then
      // re-answers: a re-read never leaves a stale offer on screen.
      ['session-1', false],
      ['session-1', true],
    ]);
  });

  it('keys answers by session so a slow read cannot bleed across a switch', async () => {
    const availability: Availability = [];
    const slow = deferred<{ readonly disposition: 'ready' | 'parked' }>();
    const tracker = track(
      (sessionId) =>
        sessionId === 'session-slow' ? slow.promise : Promise.resolve({ disposition: 'ready' as const }),
      availability,
    );

    tracker.request('session-slow');
    tracker.request('session-fast');
    await flush();
    slow.resolve({ disposition: 'parked' });
    await flush();

    assert.deepEqual(availability, [
      ['session-fast', true],
      ['session-slow', false],
    ]);
  });

  it('retracts a visible offer while a fresh read is in flight', async () => {
    const availability: Availability = [];
    const reanswer = deferred<{ readonly disposition: 'ready' | 'parked' }>();
    let calls = 0;
    const tracker = track(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ disposition: 'ready' as const })
        : reanswer.promise;
    }, availability);

    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability, [['session-1', true]]);

    tracker.request('session-1');
    // The re-read hides the stale offer synchronously, before its answer lands.
    assert.deepEqual(availability, [
      ['session-1', true],
      ['session-1', false],
    ]);

    reanswer.resolve({ disposition: 'ready' });
    await flush();
    assert.deepEqual(availability, [
      ['session-1', true],
      ['session-1', false],
      ['session-1', true],
    ]);
  });
});
