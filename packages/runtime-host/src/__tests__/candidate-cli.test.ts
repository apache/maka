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
const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000002';

const required = [
  '--root',
  '/tmp/workspace',
  '--expected-root-id',
  ROOT_ID,
  '--startup-attempt-id',
  STARTUP_ATTEMPT_ID,
] as const;

test('candidate options are order-independent and preserve explicit values', () => {
  const optionalPairs = [
    ['--idle-grace-ms', '10000'],
    ['--initial-connection-timeout-ms', '250'],
    ['--handshake-timeout-ms', '500'],
    ['--generation', 'candidate-7'],
    ['--managed-deployment-id', DEPLOYMENT_ID],
    ['--managed-config-revision', '7'],
  ] as const;
  const forward = parseInteractiveRuntimeHostCandidateArguments([
    ...required,
    ...optionalPairs.flat(),
  ]);
  const reverse = parseInteractiveRuntimeHostCandidateArguments([
    ...[...optionalPairs].reverse().flat(),
    ...required,
  ]);

  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward, {
    rootPath: '/tmp/workspace',
    expectedRootId: ROOT_ID,
    startupAttemptId: STARTUP_ATTEMPT_ID,
    idleGraceMs: 10_000,
    initialConnectionTimeoutMs: 250,
    handshakeTimeoutMs: 500,
    generation: 'candidate-7',
    managedLaunchClaim: { deploymentId: DEPLOYMENT_ID, configRevision: 7 },
  });
});

test('candidate parser rejects malformed or ambiguous argument streams', () => {
  const cases: ReadonlyArray<{ args: readonly string[]; error: RegExp }> = [
    { args: [...required, '--desktop-e2e', '1'], error: /--desktop-e2e/ },
    { args: [...required, '--root', '/other'], error: /--root/ },
    { args: [...required, '--idle-grace-ms'], error: /candidate arguments/ },
    { args: required.slice(0, -2), error: /--startup-attempt-id/ },
    {
      args: [...required, '--managed-deployment-id', DEPLOYMENT_ID],
      error: /complete managed launch claim/,
    },
    {
      args: [...required, '--managed-config-revision', '1'],
      error: /complete managed launch claim/,
    },
  ];

  for (const { args, error } of cases) {
    assert.throws(() => parseInteractiveRuntimeHostCandidateArguments(args), error);
  }
});

test('integer fields accept safe integers and reject every non-integer spelling', () => {
  for (const value of ['0', '-1', '9007199254740991']) {
    assert.equal(
      parseInteractiveRuntimeHostCandidateArguments([...required, '--idle-grace-ms', value])
        .idleGraceMs,
      Number(value),
    );
  }
  for (const value of ['1.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(
      () => parseInteractiveRuntimeHostCandidateArguments([...required, '--idle-grace-ms', value]),
      /--idle-grace-ms/,
    );
  }
});
