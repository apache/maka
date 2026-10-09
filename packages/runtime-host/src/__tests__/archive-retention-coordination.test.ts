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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ArchiveRetentionClockGuard,
  ArchiveRetentionTickGate,
} from '../server/archive-retention-coordination.js';

test('retention clock guard pauses behind its high-water mark and holds only a forward gap over threshold', () => {
  const clock = new ArchiveRetentionClockGuard();
  clock.seed(100, 110);
  assert.deepEqual(clock.observe(105), { previous: 110, observedThisRun: false });
  assert.equal(clock.isBehind(105), true);
  assert.equal(clock.hasForwardJump(200, 110, 90), false);
  assert.equal(clock.hasForwardJump(201, 110, 90), true);

  clock.recordSettingTime(120);
  assert.deepEqual(clock.observe(121), { previous: 120, observedThisRun: true });
  assert.equal(clock.isBehind(121), false);
});

test('a retention setting change waits for the active tick and blocks new ticks', async () => {
  const gate = new ArchiveRetentionTickGate();
  let finishTick!: () => void;
  const tickFinished = new Promise<void>((resolve) => {
    finishTick = resolve;
  });
  const tick = gate.runTick(async () => {
    await tickFinished;
    return false;
  });

  let settingChanged = false;
  const change = gate.runSettingChange(async () => {
    settingChanged = true;
  });
  assert.equal(gate.changePending, true);
  assert.equal(await gate.runTick(async () => true), true);
  assert.equal(settingChanged, false);

  finishTick();
  await Promise.all([tick, change]);
  assert.equal(settingChanged, true);
  assert.equal(gate.changePending, false);
});
