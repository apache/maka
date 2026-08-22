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
import { SessionTerminalHydration } from '../../renderer/session-terminal-hydration.js';

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
