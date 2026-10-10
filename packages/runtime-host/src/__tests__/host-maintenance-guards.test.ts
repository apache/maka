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
import { HostClockGuard, SettingTickGate } from '../server/host-maintenance-guards.js';

test('clock decision pauses behind the high-water mark and holds a forward gap', async () => {
  const clock = new HostClockGuard();
  clock.seed(100, 110);
  let reads = 0;
  const readLatest = async () => {
    reads += 1;
    return 110;
  };
  assert.deepEqual(
    await clock.decideTick({
      now: 105,
      gapThreshold: 90,
      checkBackwards: true,
      readLatestSessionMetadataTime: readLatest,
    }),
    {
      kind: 'pause',
      previous: 110,
      observedThisRun: false,
    },
  );
  assert.equal(reads, 1);

  clock.recordSettingTime(120);
  assert.deepEqual(
    await clock.decideTick({
      now: 121,
      gapThreshold: 90,
      checkBackwards: true,
      readLatestSessionMetadataTime: readLatest,
    }),
    {
      kind: 'ok',
      previous: 120,
      observedThisRun: true,
    },
  );
  assert.deepEqual(
    await clock.decideTick({
      now: 212,
      gapThreshold: 90,
      checkBackwards: false,
      readLatestSessionMetadataTime: readLatest,
    }),
    {
      kind: 'hold',
      since: 121,
      previous: 121,
      observedThisRun: true,
    },
  );
  assert.equal(clock.shouldClearHold(199, 200), false);
  assert.equal(clock.shouldClearHold(200, 200), true);
});

test('seed does not count as an observation in this process', async () => {
  const clock = new HostClockGuard();
  clock.seed(100);
  let reads = 0;
  const decision = await clock.decideTick({
    now: 101,
    gapThreshold: 1000,
    checkBackwards: false,
    readLatestSessionMetadataTime: async () => {
      reads += 1;
      return 99;
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(decision, { kind: 'ok', previous: 100, observedThisRun: false });
});

test('a setting change waits for the active tick and blocks new ticks', async () => {
  const gate = new SettingTickGate();
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
  let blockedTickRan = false;
  assert.equal(
    await gate.runTick(async () => {
      blockedTickRan = true;
      return false;
    }),
    true,
  );
  assert.equal(blockedTickRan, false);
  assert.equal(settingChanged, false);

  finishTick();
  await Promise.all([tick, change]);
  assert.equal(settingChanged, true);
  assert.equal(gate.changePending, false);
});

test('a setting change proceeds after an active tick rejects', async () => {
  const gate = new SettingTickGate();
  const failedTick = gate.runTick(async () => {
    throw new Error('tick failed');
  });
  await assert.rejects(failedTick, /tick failed/);
  let changed = false;
  await gate.runSettingChange(async () => {
    changed = true;
  });
  assert.equal(changed, true);
});
