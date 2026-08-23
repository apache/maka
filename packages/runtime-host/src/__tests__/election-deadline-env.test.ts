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
import {
  ELECTION_DEADLINE_MS_ENV_VAR,
  connectOrSpawnRuntimeHostWithDependencies,
  electionDeadlineMsFromEnvironment,
} from '../client/connect-or-spawn.js';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '../protocol/index.js';

test('treats an unset or blank override as unconfigured', () => {
  assert.equal(electionDeadlineMsFromEnvironment(undefined), undefined);
  assert.equal(electionDeadlineMsFromEnvironment(''), undefined);
  assert.equal(electionDeadlineMsFromEnvironment('   '), undefined);
});

test('parses a valid millisecond override', () => {
  assert.equal(electionDeadlineMsFromEnvironment('90000'), 90_000);
  assert.equal(electionDeadlineMsFromEnvironment(' 5000 '), 5_000);
});

test('fails closed on an invalid override instead of silently ignoring it', () => {
  for (const invalid of ['abc', '0', '-100', '120001', '1.5']) {
    assert.throws(() => electionDeadlineMsFromEnvironment(invalid), RangeError);
  }
  assert.throws(
    () => electionDeadlineMsFromEnvironment('abc'),
    new RegExp(`${ELECTION_DEADLINE_MS_ENV_VAR} must be an integer`, 'u'),
  );
});

test('an invalid environment override fails the election before touching storage', async () => {
  await assert.rejects(
    connectOrSpawnRuntimeHostWithDependencies(
      {
        rootPath: '/nonexistent-maka-3474-root',
        protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
        compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
        candidateEntrypoint: 'candidate-entry.js',
      },
      {
        launchCandidate: () => ({ spawned: Promise.reject(new Error('must not spawn')) }),
        random: Math.random,
        env: { [ELECTION_DEADLINE_MS_ENV_VAR]: 'not-a-number' },
      },
    ),
    (error: unknown) =>
      error instanceof RangeError && /MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS/u.test(error.message),
  );
});
