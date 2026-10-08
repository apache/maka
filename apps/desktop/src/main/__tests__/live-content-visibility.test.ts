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
  INITIAL_LIVE_CONTENT_SEED,
  INITIAL_OBSERVATION_AUTHORITY,
  beginLiveContentSeed,
  ownsLiveContentSeed,
  reconcileObservationAuthority,
  revealLiveContentSeed,
  visibleLiveContentGeneration,
} from '../../renderer/features/conversation/testing.js';

test('observation generations change only when the owning source changes', () => {
  const selected = reconcileObservationAuthority(
    INITIAL_OBSERVATION_AUTHORITY,
    { sessionId: 'session-a' },
  );
  const hydrated = reconcileObservationAuthority(selected, {
    sessionId: 'session-a',
    profileId: 'profile-a',
  });
  const sameProfile = reconcileObservationAuthority(hydrated, {
    sessionId: 'session-a',
    profileId: 'profile-a',
  });
  const changedProfile = reconcileObservationAuthority(sameProfile, {
    sessionId: 'session-a',
    profileId: 'profile-b',
  });
  const changedSession = reconcileObservationAuthority(changedProfile, {
    sessionId: 'session-b',
    profileId: 'profile-b',
  });

  assert.deepEqual(
    [selected.generation, hydrated.generation, sameProfile.generation, changedProfile.generation, changedSession.generation],
    [1, 1, 1, 2, 3],
  );
  assert.equal(hydrated.profileId, 'profile-a');
});

test('only the current seed token can reveal live content', () => {
  const first = beginLiveContentSeed(INITIAL_LIVE_CONTENT_SEED, 'session-a');
  const second = beginLiveContentSeed(first.state, 'session-b');
  const current = beginLiveContentSeed(second.state, 'session-a');

  assert.equal(ownsLiveContentSeed(current.state, first.token), false);
  assert.equal(revealLiveContentSeed(current.state, first.token), current.state);
  assert.equal(visibleLiveContentGeneration(current.state, 'session-a'), 0);

  const visible = revealLiveContentSeed(current.state, current.token);
  assert.equal(ownsLiveContentSeed(visible, current.token), true);
  assert.equal(visibleLiveContentGeneration(visible, 'session-a'), 3);
  assert.equal(visibleLiveContentGeneration(visible, 'session-b'), 0);

  const recovery = beginLiveContentSeed(visible, 'session-a');
  assert.equal(visibleLiveContentGeneration(recovery.state, 'session-a'), 0);
  assert.equal(
    visibleLiveContentGeneration(revealLiveContentSeed(recovery.state, recovery.token), 'session-a'),
    4,
  );
});
