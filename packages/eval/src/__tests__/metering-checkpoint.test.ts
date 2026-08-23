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
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverExternalMetering } from '../external-subject.js';
import {
  METERING_CHECKPOINT_LIMIT_BYTES,
  readBoundedRegularFile,
  signMeteringCheckpoint,
  writeJsonAtomic,
} from '../metering-checkpoint.js';

const METERING_SECRET = '0123456789abcdef0123456789abcdef';

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 2,
};

const checkpoint = {
  schemaVersion: 'maka.external_provider_usage.v2',
  profile: 'codex',
  usage,
  settled: true,
  requests: 1,
  inFlightRequests: 0,
  admittedRequests: 1,
  usageRequests: 1,
  removedWebTools: 0,
  models: [],
  toolNames: [],
};

test('chmods the temporary checkpoint before rename so the published file is 0644', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-metering-atomic-'));
  const path = join(root, 'codex.provider-usage.json');
  const previous = process.umask(0o077);
  try {
    await writeJsonAtomic(path, { ok: true });
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ok: true });
  } finally {
    process.umask(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a metering checkpoint that is not a bounded regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-metering-bound-'));
  const trialPath = join(root, 'trial');
  const agent = join(trialPath, 'agent');
  const path = join(agent, 'codex.provider-usage.json');
  try {
    await mkdir(agent, { recursive: true });

    await writeFile(
      path,
      `${JSON.stringify(signMeteringCheckpoint(checkpoint, METERING_SECRET))}\n`,
    );
    assert.ok(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
    );

    // Schema-valid unsigned JSON is what a subject can write. Recovery must
    // refuse it: the file is a bounded regular checkpoint, not evidence.
    await writeFile(path, `${JSON.stringify(checkpoint)}\n`);
    assert.equal(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
      undefined,
    );

    const forged = signMeteringCheckpoint({ ...checkpoint, admittedRequests: 99 }, METERING_SECRET);
    await writeFile(path, `${JSON.stringify({ ...forged, admittedRequests: 1 })}\n`);
    assert.equal(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
      undefined,
    );

    await writeFile(
      path,
      `${JSON.stringify(signMeteringCheckpoint(checkpoint, 'ff'.repeat(16)))}\n`,
    );
    assert.equal(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
      undefined,
    );

    await rm(path);
    await symlink('/etc/hosts', path);
    assert.equal(await readBoundedRegularFile(path), undefined);
    assert.equal(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
      undefined,
    );

    await rm(path);
    await writeFile(path, 'x'.repeat(METERING_CHECKPOINT_LIMIT_BYTES + 1));
    await chmod(path, 0o644);
    assert.equal(await readBoundedRegularFile(path), undefined);
    assert.equal(
      await recoverExternalMetering({ trialPath, meteringSecret: METERING_SECRET }, 'codex'),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
