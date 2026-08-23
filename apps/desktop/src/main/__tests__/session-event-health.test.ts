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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createSessionEventStreamSubscription,
  evaluateSessionEventStreamSnapshot,
  hasInFlightToolActivity,
  recordSessionEventStreamChange,
  recordSessionEventStreamEvent,
} from '../../renderer/session-event-health.js';

describe('renderer session event health projection', () => {

  it('marks stale running sessions and asks for one throttled refresh', () => {
    const previous = createSessionEventStreamSubscription({ sessionId: 's1', now: 1_000 });
    const stale = evaluateSessionEventStreamSnapshot({
      previous,
      now: 16_000,
      sessionStatus: 'running',
      hasLiveActivity: false,
    });
    assert.equal(stale.snapshot?.status, 'stale');
    assert.equal(stale.snapshot?.staleSince, 16_000);
    assert.equal(stale.shouldRefresh, true);

    const throttled = evaluateSessionEventStreamSnapshot({
      previous: stale.snapshot,
      now: 20_000,
      sessionStatus: 'running',
      hasLiveActivity: false,
    });
    assert.equal(throttled.snapshot?.status, 'stale');
    assert.equal(throttled.snapshot?.refreshRequestedAt, 16_000);
    assert.equal(throttled.shouldRefresh, false);
  });

  it('uses sessions:changed as a recovery signal when stream deltas are quiet', () => {
    const previous = {
      ...createSessionEventStreamSubscription({ sessionId: 's1', now: 1_000 }),
      status: 'stale' as const,
      staleSince: 16_000,
    };
    const changed = recordSessionEventStreamChange(previous, 16_500);
    assert.equal(changed.status, 'recovered');
    assert.equal(changed.lastChangedAt, 16_500);
    assert.equal(changed.staleSince, undefined);
  });

  it('uses any direct session event as a recovery signal', () => {
    const previous = {
      ...createSessionEventStreamSubscription({ sessionId: 's1', now: 1_000 }),
      status: 'stale' as const,
      staleSince: 16_000,
    };
    const changed = recordSessionEventStreamEvent(previous, 16_250);
    assert.equal(changed.status, 'recovered');
    assert.equal(changed.lastEventAt, 16_250);
    assert.equal(changed.staleSince, undefined);
  });

  it('closes the projection when no stream is expected', () => {
    const previous = createSessionEventStreamSubscription({ sessionId: 's1', now: 1_000 });
    const result = evaluateSessionEventStreamSnapshot({
      previous,
      now: 30_000,
      sessionStatus: 'active',
      hasLiveActivity: false,
    });
    assert.equal(result.snapshot?.status, 'closed');
    assert.equal(result.shouldRefresh, false);
  });

  it('does not treat terminal live tools as ongoing event-stream activity', () => {
    assert.equal(
      hasInFlightToolActivity([
        { status: 'completed' },
        { status: 'errored' },
        { status: 'interrupted' },
      ]),
      false,
    );
    assert.equal(hasInFlightToolActivity([{ status: 'pending' }]), true);
    assert.equal(hasInFlightToolActivity([{ status: 'running' }]), true);
  });

});
