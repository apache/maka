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

import { strict as assert } from 'node:assert';
import { test as verify } from 'node:test';
import * as candidateCli from '../candidate-cli.js';
const ROOT_ID = ''.padStart(64, 'a');
const fixedUuid = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const STARTUP_ATTEMPT_ID = fixedUuid(1);
const DEPLOYMENT_ID = fixedUuid(2);
type ArgumentPair = Readonly<[flag: string, value: string]>;
const REQUIRED_ARGUMENTS: readonly ArgumentPair[] = [
  ['--root', '/tmp/workspace'],
  ['--expected-root-id', ROOT_ID],
  ['--startup-attempt-id', STARTUP_ATTEMPT_ID],
];
const argv = (pairs: readonly ArgumentPair[]): string[] =>
  pairs.flatMap(([flag, value]) => [flag, value]);
const parse = (pairs: readonly ArgumentPair[]) =>
  candidateCli.parseInteractiveRuntimeHostCandidateArguments(
    argv([...REQUIRED_ARGUMENTS, ...pairs]),
  );

function verifyOrderIndependence() {
  const optionalPairs = [
    ['--idle-grace-ms', '10000'],
    ['--initial-connection-timeout-ms', '250'],
    ['--handshake-timeout-ms', '500'],
    ['--generation', 'candidate-7'],
    ['--managed-deployment-id', DEPLOYMENT_ID],
    ['--managed-config-revision', '7'],
  ] as const;
  const forward = parse(optionalPairs);
  const reverse = candidateCli.parseInteractiveRuntimeHostCandidateArguments(
    argv([...optionalPairs].reverse()).concat(argv(REQUIRED_ARGUMENTS)),
  );

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
}
function verifyMalformedArguments() {
  const required = argv(REQUIRED_ARGUMENTS);
  const cases: readonly { args: readonly string[]; error: RegExp }[] = [
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
    assert.throws(() => candidateCli.parseInteractiveRuntimeHostCandidateArguments(args), error);
  }
}

function verifyIntegerPartitions() {
  const partitions = [
    { values: ['0', '-1', '9007199254740991'], accepted: true },
    { values: ['1.5', 'NaN', 'Infinity', '9007199254740992'], accepted: false },
  ] as const;
  for (const partition of partitions) {
    for (const value of partition.values) {
      const evaluate = () => parse([['--idle-grace-ms', value]]).idleGraceMs;
      if (partition.accepted) assert.equal(evaluate(), Number(value));
      else assert.throws(evaluate, /--idle-grace-ms/);
    }
  }
}

verify(
  'candidate options are order-independent and preserve explicit values',
  verifyOrderIndependence,
);
verify(
  'candidate parser rejects malformed or ambiguous argument streams',
  verifyMalformedArguments,
);
verify(
  'integer fields form two complete accepted and rejected partitions',
  verifyIntegerPartitions,
);
