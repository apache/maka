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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyProbeResult } from './macos-checkpoint-capability-probe.mjs';

test('a permissions failure is unavailable, not a successful acceptance test', () => {
  for (const createErrno of [1, 13, 45]) {
    assert.equal(
      classifyProbeResult({ created: false, deleteAttempted: false, createErrno }, 2),
      'unavailable',
    );
  }
});

test('even creation and deletion success does not establish production readiness', () => {
  assert.equal(
    classifyProbeResult({ created: true, deleted: true }, 0),
    'create_delete_only_mount_and_distribution_unverified',
  );
});

test('cleanup failure, unexpected failures and inconsistent reports fail closed', () => {
  for (const [result, exitCode] of [
    [{ created: true, deleted: false }, 1],
    [{ created: true, deleted: false }, 0],
    [{ created: false, deleteAttempted: false, createErrno: 5 }, 2],
    [{ created: false, deleteAttempted: true, createErrno: 1 }, 2],
    [undefined, 0],
  ]) {
    assert.equal(classifyProbeResult(result, exitCode), 'probe_error');
  }
});

test('the runner rejects caller-supplied paths before creating any resources', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./macos-checkpoint-capability-probe.mjs', import.meta.url)), '/'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No arguments accepted/);
  assert.doesNotMatch(result.stderr, /Disposable probe directory/);
});
