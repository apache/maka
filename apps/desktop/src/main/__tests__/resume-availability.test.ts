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

type PlanStub =
  | {
      readonly disposition: 'ready';
      readonly sourceTurnId?: string;
      readonly sourceRunId?: string;
    }
  | { readonly disposition: 'parked' };

function track(
  query: (sessionId: string) => Promise<PlanStub>,
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

  it('keeps the stopped candidate hidden across duplicate terminal notifications', async () => {
    const availability: Availability = [];
    const gate = deferred<void>();
    let queries = 0;
    const tracker = track(async () => {
      queries += 1;
      await gate.promise;
      // Both reads observe the same stopped candidate: identical source Turn
      // and Run. One stop publishes the terminal notification twice (observer
      // frame and stop IPC), producing an in-flight read plus a trailing one.
      return { disposition: 'ready' as const, sourceTurnId: 'turn-1', sourceRunId: 'run-1' };
    }, availability);

    tracker.noteUserStopped('session-1');
    tracker.request('session-1');
    tracker.request('session-1');
    gate.resolve();
    await flush();

    assert.equal(queries, 2);
    // The first ready answer captures the stopped candidate's identity; the
    // trailing read observes the very same candidate and stays hidden.
    assert.deepEqual(availability, [
      ['session-1', false],
      ['session-1', false],
    ]);
  });

  it('offers again once the resume candidate moves on to a new run or turn', async () => {
    const availability: Availability = [];
    const plans: PlanStub[] = [
      { disposition: 'ready', sourceTurnId: 'turn-1', sourceRunId: 'run-1' },
      { disposition: 'ready', sourceTurnId: 'turn-1', sourceRunId: 'run-1' },
      // The stopped Turn was resumed (via the banner) and interrupted again:
      // a new source run is a candidate the user did not just stop.
      { disposition: 'ready', sourceTurnId: 'turn-1', sourceRunId: 'run-2' },
      // A genuinely different interruption.
      { disposition: 'ready', sourceTurnId: 'turn-2', sourceRunId: 'run-3' },
    ];
    const tracker = track(async () => plans.shift() ?? { disposition: 'parked' as const }, availability);

    tracker.noteUserStopped('session-1');
    tracker.request('session-1');
    await flush();
    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability, [
      ['session-1', false],
      ['session-1', false],
    ]);

    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability.at(-1), ['session-1', true]);

    // The last emission was a visible offer, so this re-read retracts it in
    // flight before answering — then the new candidate shows.
    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability, [
      ['session-1', false],
      ['session-1', false],
      ['session-1', true],
      ['session-1', false],
      ['session-1', true],
    ]);
  });

  it('hides a visible offer the moment the user stops a Turn', async () => {
    const availability: Availability = [];
    const tracker = track(async () => ({ disposition: 'ready' as const }), availability);

    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability, [['session-1', true]]);

    tracker.noteUserStopped('session-1');
    assert.deepEqual(availability, [
      ['session-1', true],
      ['session-1', false],
    ]);
  });

  it('keeps the stop capture armed until a ready answer identifies the candidate', async () => {
    const availability: Availability = [];
    const plans: PlanStub[] = [
      // Parked answers (session busy, candidate missing) cannot identify —
      // and must not spend — the capture: the first READY answer names the
      // stopped Turn.
      { disposition: 'parked' },
      { disposition: 'ready', sourceTurnId: 'turn-1', sourceRunId: 'run-1' },
      { disposition: 'ready', sourceTurnId: 'turn-1', sourceRunId: 'run-1' },
    ];
    const tracker = track(async () => plans.shift() ?? { disposition: 'parked' as const }, availability);

    tracker.noteUserStopped('session-1');
    tracker.request('session-1');
    await flush();
    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability, [
      ['session-1', false],
      ['session-1', false],
    ]);

    // Once captured, the stopped candidate stays hidden on every re-read.
    tracker.request('session-1');
    await flush();
    assert.deepEqual(availability.at(-1), ['session-1', false]);
  });

  it('scopes the stop suppression to the session that was stopped', async () => {
    const availability: Availability = [];
    const tracker = track(async () => ({ disposition: 'ready' as const }), availability);

    tracker.noteUserStopped('session-1');
    tracker.request('session-2');
    await flush();

    assert.deepEqual(availability, [['session-2', true]]);
  });
});
