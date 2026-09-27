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
import {
  EMPTY_LIVE_CONTENT_GATE,
  EMPTY_SESSION_OBSERVATION_AUTHORITY,
  advanceSessionObservationAuthority,
  closeLiveContentGate,
  openLiveContentGate,
  visibleLiveContentRevision,
} from '../../renderer/live-content-seed.js';

test('catalog hydration does not replace an already-bound Session observation', () => {
  const selected = advanceSessionObservationAuthority(
    EMPTY_SESSION_OBSERVATION_AUTHORITY,
    'session-a',
    undefined,
  );
  const hydrated = advanceSessionObservationAuthority(selected, 'session-a', 'profile-a');

  assert.equal(hydrated.profileId, 'profile-a');
  assert.equal(hydrated.revision, selected.revision);
});

test('a real Session observation authority handoff advances the revision', () => {
  const selected = advanceSessionObservationAuthority(
    EMPTY_SESSION_OBSERVATION_AUTHORITY,
    'session-a',
    'profile-a',
  );
  const handedOff = advanceSessionObservationAuthority(selected, 'session-a', 'profile-b');

  assert.equal(handedOff.profileId, 'profile-b');
  assert.equal(handedOff.revision, selected.revision + 1);
});

test('live content gate publishes only the matching Session observation revision', () => {
  const first = closeLiveContentGate(EMPTY_LIVE_CONTENT_GATE, 'session-a');
  const switched = closeLiveContentGate(first, 'session-b');
  const returned = closeLiveContentGate(switched, 'session-a');

  assert.deepEqual(
    [first.issuedRevision, switched.issuedRevision, returned.issuedRevision],
    [1, 2, 3],
  );
  for (const sessionId of ['session-a', 'session-b']) {
    assert.equal(visibleLiveContentRevision(returned, sessionId), 0);
  }

  const stale = openLiveContentGate(returned, 'session-a', first.issuedRevision);
  assert.equal(stale, returned);
  assert.equal(visibleLiveContentRevision(stale, 'session-a'), 0);

  const visible = openLiveContentGate(returned, 'session-a', returned.issuedRevision);
  assert.equal(visibleLiveContentRevision(visible, 'session-a'), returned.issuedRevision);
  assert.equal(visibleLiveContentRevision(visible, 'session-b'), 0);
});

test('recovery closes previously visible content until its own revision opens', () => {
  const initial = closeLiveContentGate(EMPTY_LIVE_CONTENT_GATE, 'session-a');
  const visible = openLiveContentGate(initial, 'session-a', initial.issuedRevision);
  const recovering = closeLiveContentGate(visible, 'session-a');

  assert.equal(visibleLiveContentRevision(visible, 'session-a'), 1);
  assert.equal(visibleLiveContentRevision(recovering, 'session-a'), 0);

  const recovered = openLiveContentGate(
    recovering,
    'session-a',
    recovering.issuedRevision,
  );
  assert.equal(visibleLiveContentRevision(recovered, 'session-a'), 2);
});
