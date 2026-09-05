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
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import {
  clearCandidateStartupDiagnostic,
  clearSelectedCandidateStartupDiagnostic,
  readCandidateStartupDiagnostic,
  resolveCandidateStartupDiagnosticPath,
  selectCandidateStartupDiagnostic,
  writeCandidateStartupDiagnostic,
} from '../control/startup-diagnostic.js';

test('preserves a bounded redacted Candidate startup diagnostic in the private control root', async () => {
  const rootId = createHash('sha256').update(randomUUID()).digest('hex');
  const selectedAttemptId = randomUUID();
  const otherAttemptId = randomUUID();
  const attemptPath = resolveCandidateStartupDiagnosticPath(rootId, selectedAttemptId);
  const selectedPath = resolveCandidateStartupDiagnosticPath(rootId);
  const controlDirectory = dirname(attemptPath);
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
  try {
    const helperDiagnostic = JSON.stringify({
      schemaVersion: 1,
      helper: 'windows_pipe_acl',
      stderr: JSON.stringify({ stage: 'acl_apply', hresult: -2_147_024_891 }),
    });
    await writeCandidateStartupDiagnostic({
      rootId,
      startupAttemptId: selectedAttemptId,
      failure: { reason: 'local_ipc_security_failed' },
      error: new Error('Unable to secure endpoint', { cause: new Error(helperDiagnostic) }),
      logs: [`startup token=sk-${'a'.repeat(24)}`, 'endpoint setup failed'],
    });

    await writeCandidateStartupDiagnostic({
      rootId,
      startupAttemptId: otherAttemptId,
      failure: { reason: 'internal_startup_failure' },
      error: new Error('Different Candidate failure'),
    });
    await selectCandidateStartupDiagnostic(rootId, selectedAttemptId);

    const diagnostic = await readCandidateStartupDiagnostic(rootId);
    assert.ok(diagnostic);
    assert.equal(diagnostic.rootId, rootId);
    assert.equal(diagnostic.startupAttemptId, selectedAttemptId);
    assert.equal(diagnostic.reason, 'local_ipc_security_failed');
    assert.match(diagnostic.errorChain[1]?.message ?? '', /windows_pipe_acl/u);
    assert.match(diagnostic.errorChain[1]?.message ?? '', /acl_apply/u);
    assert.deepEqual(diagnostic.logs, ['startup token=[redacted]', 'endpoint setup failed']);
    assert.equal((await stat(selectedPath)).mode & 0o077, 0);

    const otherDiagnostic = await readCandidateStartupDiagnostic(rootId, otherAttemptId);
    assert.equal(otherDiagnostic?.reason, 'internal_startup_failure');

    await utimes(
      resolveCandidateStartupDiagnosticPath(rootId, otherAttemptId),
      new Date(0),
      new Date(0),
    );
    const freshAttemptId = randomUUID();
    await writeCandidateStartupDiagnostic({
      rootId,
      startupAttemptId: freshAttemptId,
      failure: { reason: 'internal_startup_failure' },
      error: new Error('Fresh Candidate failure'),
    });
    assert.equal(await readCandidateStartupDiagnostic(rootId, otherAttemptId), undefined);

    assert.equal(await clearSelectedCandidateStartupDiagnostic(rootId, otherAttemptId), false);
    assert.equal(await clearSelectedCandidateStartupDiagnostic(rootId, selectedAttemptId), true);
    await clearCandidateStartupDiagnostic(rootId, freshAttemptId);
    assert.equal(await readCandidateStartupDiagnostic(rootId), undefined);
  } finally {
    await rm(controlDirectory, { recursive: true, force: true });
  }
});
