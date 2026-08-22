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
  EMPTY_LIVE_CONTENT_SEED,
  beginLiveContentSeed,
  completeLiveContentSeed,
  liveContentSeedRevision,
} from '../../renderer/live-content-seed.js';

test('withholds live content until the current observation generation is ready', () => {
  const first = beginLiveContentSeed(EMPTY_LIVE_CONTENT_SEED, 'session-a');
  assert.equal(liveContentSeedRevision(first, 'session-a'), 0);

  const ready = completeLiveContentSeed(first, 'session-a', first.generation);
  assert.equal(liveContentSeedRevision(ready, 'session-a'), first.generation);
  assert.equal(liveContentSeedRevision(ready, 'session-b'), 0);
});

test('A → B → A does not reuse the previous ready generation', () => {
  const firstReady = completeLiveContentSeed(
    beginLiveContentSeed(EMPTY_LIVE_CONTENT_SEED, 'session-a'),
    'session-a',
    1,
  );
  assert.equal(liveContentSeedRevision(firstReady, 'session-a'), 1);

  const pendingB = beginLiveContentSeed(firstReady, 'session-b');
  assert.equal(liveContentSeedRevision(pendingB, 'session-b'), 0);
  assert.equal(liveContentSeedRevision(pendingB, 'session-a'), 0);

  const pendingA = beginLiveContentSeed(pendingB, 'session-a');
  assert.equal(pendingA.generation, 3);
  assert.equal(liveContentSeedRevision(pendingA, 'session-a'), 0);

  const staleFirstSeed = completeLiveContentSeed(pendingA, 'session-a', 1);
  assert.equal(staleFirstSeed, pendingA);
  assert.equal(liveContentSeedRevision(staleFirstSeed, 'session-a'), 0);

  const recovered = completeLiveContentSeed(pendingA, 'session-a', pendingA.generation);
  assert.equal(liveContentSeedRevision(recovered, 'session-a'), 3);
});

test('a recovery generation only exposes live content after that generation completes', () => {
  const firstReady = completeLiveContentSeed(
    beginLiveContentSeed(EMPTY_LIVE_CONTENT_SEED, 'session-a'),
    'session-a',
    1,
  );
  const recovering = beginLiveContentSeed(firstReady, 'session-a');
  assert.equal(liveContentSeedRevision(recovering, 'session-a'), 0);

  const stale = completeLiveContentSeed(recovering, 'session-a', firstReady.generation);
  assert.equal(liveContentSeedRevision(stale, 'session-a'), 0);

  const ready = completeLiveContentSeed(recovering, 'session-a', recovering.generation);
  assert.equal(liveContentSeedRevision(ready, 'session-a'), 2);
});
