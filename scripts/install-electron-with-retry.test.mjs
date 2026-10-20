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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installWithRetry,
  resolveAttemptTimeoutMs,
  runInstallerAttempt,
} from './install-electron-with-retry.mjs';

test('waits through a sustained transient Electron download outage', async () => {
  const attempts = [];
  const delays = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 5
        ? { status: 1, context: '{"kind":"http","status":500}' }
        : { status: 0, context: '' };
    },
    {
      wait: async (delay) => delays.push(delay),
      warn: () => {},
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000]);
});

test('retries an attempt that exceeded the per-attempt timeout', async () => {
  const attempts = [];
  const delays = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 3
        ? { status: null, signal: 'SIGTERM', timedOut: true, context: '' }
        : { status: 0, context: '' };
    },
    {
      wait: async (delay) => delays.push(delay),
      warn: () => {},
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [2_000, 4_000]);
});

test('keeps terminal signal termination immediate', async () => {
  const attempts = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return { status: null, signal: 'SIGINT', context: '' };
    },
    {
      wait: async () => assert.fail('a terminal signal must not be retried'),
      warn: () => {},
    },
  );

  assert.equal(result.signal, 'SIGINT');
  assert.deepEqual(attempts, [1]);
});

test('resolves the per-attempt timeout from the environment', () => {
  const variable = 'MAKA_ELECTRON_INSTALL_ATTEMPT_TIMEOUT_MS';

  assert.equal(resolveAttemptTimeoutMs({}), 600_000);
  assert.equal(resolveAttemptTimeoutMs({ [variable]: '15000' }), 15_000);
  assert.equal(resolveAttemptTimeoutMs({ [variable]: '0' }), 600_000);
  assert.equal(resolveAttemptTimeoutMs({ [variable]: 'soon' }), 600_000);
});

test('aborts an installer attempt that outlives the timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-electron-attempt-'));
  const installerPath = join(directory, 'stall-installer.cjs');
  await writeFile(installerPath, 'setInterval(() => {}, 60_000);\n');
  const reports = [];

  try {
    const result = runInstallerAttempt({
      installerPath,
      launcherPath: fileURLToPath(new URL('./run-electron-installer.cjs', import.meta.url)),
      repositoryRoot: process.cwd(),
      timeoutMs: 2_000,
      report: (text) => reports.push(text),
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.status, null);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.spawnError, undefined);
    assert.match(reports.join(''), /attempt aborted after 2000ms/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
