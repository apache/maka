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
import test from 'node:test';
import { releaseSessionObservation } from '../../preload/session-observation-release.js';

test('releases a Session observation before and after its queued dispatch settles', async () => {
  let settleObservation!: () => void;
  const completion = new Promise<void>((resolve) => {
    settleObservation = resolve;
  });
  let releases = 0;
  const releasing = releaseSessionObservation(Promise.resolve({ completion }), async () => {
    releases += 1;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
  settleObservation();
  await releasing;
  assert.equal(releases, 2);
});
