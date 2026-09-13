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
import { SessionTerminalHydration, SessionTerminalRenderQueue } from '../../renderer/features/workbar/testing.js';

test('slow xterm parsing has one in-flight write and bounded terminal-only recovery', () => {
  const writes: string[] = [];
  const completions: (() => void)[] = [];
  let resets = 0;
  let resyncs = 0;
  const queue = new SessionTerminalRenderQueue({
    write(data, done) { writes.push(data); completions.push(done); },
    reset() { resets += 1; }, resync() { resyncs += 1; },
  });
  queue.append('first');
  for (let i = 0; i < 1000; i += 1) queue.append('x'.repeat(4096));
  assert.deepEqual(writes, ['first']);
  assert.equal(resyncs, 0, 'recovery must wait for the congested parser');
  completions.shift()!();
  assert.equal(resyncs, 1);
  queue.replace('snapshot');
  queue.append('next');
  assert.deepEqual(writes, ['first', 'snapshot']);
  assert.equal(resets, 1);
  completions.shift()!();
  assert.deepEqual(writes, ['first', 'snapshot', 'next']);
  queue.close();
  completions.shift()!();
  queue.append('after close');
  assert.equal(writes.length, 3);
});

test('a PTY gap requires a new snapshot rather than rendering incomplete escape sequences', () => {
  const hydration = new SessionTerminalHydration();
  hydration.commit(hydration.begin(), { sequence: 5, buffer: 'ready' });
  assert.equal(hydration.accept({ sequence: 7, data: 'gap' }), undefined);
  assert.equal(hydration.needsSnapshot, true);
  const epoch = hydration.begin();
  hydration.accept({ sequence: 9, data: 'next' });
  assert.deepEqual(hydration.commit(epoch, { sequence: 8, buffer: 'recovered' }), {
    snapshot: { sequence: 8, buffer: 'recovered' },
    replay: [{ sequence: 9, data: 'next' }],
  });
});

test('snapshot preparation has bounded buffering and detects a replay gap', () => {
  const hydration = new SessionTerminalHydration();
  const epoch = hydration.begin();
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    hydration.accept({ sequence, data: 'x'.repeat(4096) });
  }
  assert.equal(hydration.needsSnapshot, true);
  assert.equal(hydration.commit(epoch, { sequence: 0, buffer: '' }), undefined);
  const next = hydration.begin();
  hydration.accept({ sequence: 1002, data: 'gap' });
  assert.equal(hydration.commit(next, { sequence: 1000, buffer: '' }), undefined);
  assert.equal(hydration.needsSnapshot, true);
});

test('terminal hydration ignores an old snapshot and replays only post-resync PTY data', () => {
  const hydration = new SessionTerminalHydration();
  const oldEpoch = hydration.begin();
  hydration.accept({ sequence: 2, data: 'old' });

  const currentEpoch = hydration.begin();
  hydration.accept({ sequence: 6, data: ' after' });
  const current = hydration.commit(currentEpoch, {
    sequence: 5,
    buffer: 'ready',
  });

  assert.deepEqual(current, {
    snapshot: { sequence: 5, buffer: 'ready' },
    replay: [{ sequence: 6, data: ' after' }],
  });
  assert.equal(
    hydration.commit(oldEpoch, { sequence: 9, buffer: 'stale' }),
    undefined,
  );
  assert.deepEqual(hydration.accept({ sequence: 7, data: ' now' }), {
    sequence: 7,
    data: ' now',
  });
});
