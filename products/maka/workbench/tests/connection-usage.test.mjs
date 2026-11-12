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
import { watchUsageLimits } from '../app/usageLimitsReading.ts';

const ready = {
  kind: 'ready',
  limits: [{ kind: 'window', period: { kind: 'monthly' }, usedPercent: 25 }],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('refresh keeps the previous reading and stops publishing when the card closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const published = [];
  const stop = watchUsageLimits(
    () => new Promise((resolve) => reads.push(resolve)),
    (reading) => published.push(reading),
    null,
  );
  t.after(stop);

  reads.shift()(ready);
  await flush();
  assert.deepEqual(published, [{ result: ready, refreshFailed: false }]);

  t.mock.timers.tick(60_000);
  assert.equal(reads.length, 1);
  assert.deepEqual(published, [{ result: ready, refreshFailed: false }]);
  t.mock.timers.tick(120_000);
  assert.equal(reads.length, 1, 'a slow read must not overlap the next refresh');

  reads.shift()({ kind: 'unavailable' });
  await flush();
  assert.deepEqual(published.at(-1), { result: ready, refreshFailed: true });

  t.mock.timers.tick(60_000);
  reads.shift()({ kind: 'superseded' });
  await flush();
  assert.deepEqual(published.at(-1), {
    result: { kind: 'superseded' },
    refreshFailed: false,
  });

  t.mock.timers.tick(60_000);
  stop();
  reads.shift()(ready);
  await flush();
  t.mock.timers.tick(120_000);
  assert.equal(reads.length, 0);
  assert.equal(published.length, 3);
});
