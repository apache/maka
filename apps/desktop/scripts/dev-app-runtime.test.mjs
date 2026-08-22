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
// Probe contract for the shared "Maka Dev" owner probe (#3359): pgrep -f for
// PIDs, ps -o command= for full argv (pgrep's -a/-l flag semantics differ
// between Linux and BSD), with exit 1 on either step meaning "nothing
// running". These tests stub spawnSync so the full chain is exercised.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSharedAppProbe, sharedDevelopmentAppCommandLines } from './dev-app-runtime.mjs';

function spawnStub(pgrep, ps) {
  return (command, args) => {
    if (command === 'pgrep') return pgrep(args);
    if (command === 'ps') return ps(args);
    throw new Error(`unexpected command ${command}`);
  };
}

test('a pgrep exit outside 0/1 is a probe error, not an empty result', () => {
  const probe = createSharedAppProbe(spawnStub(() => ({ status: 2, stdout: Buffer.from('') })));
  assert.throws(() => sharedDevelopmentAppCommandLines({ probe }), /pgrep failed/);
});

test('pgrep exit 1 means no matches', () => {
  const probe = createSharedAppProbe(spawnStub(() => ({ status: 1, stdout: Buffer.from('') })));
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), []);
});

test('ps exit 1 (no such pids) also means no command lines', () => {
  const probe = createSharedAppProbe(
    spawnStub(
      () => ({ status: 0, stdout: Buffer.from('4242\n') }),
      () => ({ status: 1, stdout: Buffer.from('') }),
    ),
  );
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), []);
});

test('ps output lines are the command lines', () => {
  const lines = [
    '4242 /Users/me/codebase/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --inspect=9229',
    '4243 /Users/other/codebase/.maka-dev/Maka Dev.app/Contents/MacOS/Electron --no-sandbox',
  ];
  const probe = createSharedAppProbe(
    spawnStub(
      () => ({ status: 0, stdout: Buffer.from('4242\n4243\n') }),
      () => ({ status: 0, stdout: Buffer.from(`${lines.join('\n')}\n`) }),
    ),
  );
  assert.deepEqual(sharedDevelopmentAppCommandLines({ probe }), lines);
});
