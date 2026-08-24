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
import { parseInteractiveRuntimeHostCandidateArguments } from '../candidate-cli.js';

const ROOT_ID = 'a'.repeat(64);
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';

test('parses the production candidate flags', () => {
  const parsed = parseInteractiveRuntimeHostCandidateArguments([
    '--root',
    '/tmp/workspace',
    '--expected-root-id',
    ROOT_ID,
    '--startup-attempt-id',
    STARTUP_ATTEMPT_ID,
    '--idle-grace-ms',
    '10000',
  ]);
  assert.equal(parsed.rootPath, '/tmp/workspace');
  assert.equal(parsed.expectedRootId, ROOT_ID);
  assert.equal(parsed.startupAttemptId, STARTUP_ATTEMPT_ID);
  assert.equal(parsed.idleGraceMs, 10_000);
});

// The Desktop E2E composition is selected by its own entry module, not by a
// flag on the production CLI — so `--desktop-e2e` is simply unknown here.
test('rejects the retired desktop E2E flag as an unknown argument', () => {
  assert.throws(
    () =>
      parseInteractiveRuntimeHostCandidateArguments([
        '--root',
        '/tmp/workspace',
        '--expected-root-id',
        ROOT_ID,
        '--startup-attempt-id',
        STARTUP_ATTEMPT_ID,
        '--desktop-e2e',
        '1',
      ]),
    /Invalid Runtime Host candidate argument: --desktop-e2e/,
  );
});
