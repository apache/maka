import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import {
  readCandidateStartupDiagnostic,
  resolveCandidateStartupDiagnosticPath,
} from '../control/startup-diagnostic.js';

const CANDIDATE_ENTRYPOINT = fileURLToPath(
  new URL('../execution-candidate-main.js', import.meta.url),
);
const ROOT_ID = 'a'.repeat(64);
const STARTUP_ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';

test('classifies invalid candidate arguments as an internal startup failure', () => {
  const result = spawnSync(
    process.execPath,
    [
      CANDIDATE_ENTRYPOINT,
      '--root',
      '/tmp/workspace',
      '--expected-root-id',
      ROOT_ID,
      '--startup-attempt-id',
      STARTUP_ATTEMPT_ID,
      '--desktop-e2e',
      'true',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );

  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /\[runtime-host\] startup failed:/);
  assert.match(result.stderr, /Invalid --desktop-e2e/);
});

test('preserves a valid Candidate invocation failure across the detached stderr boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-candidate-diagnostic-'));
  const mismatchedRootId = createHash('sha256').update(randomUUID()).digest('hex');
  const startupAttemptId = randomUUID();
  const diagnosticPath = resolveCandidateStartupDiagnosticPath(mismatchedRootId, startupAttemptId);
  const controlDirectory = dirname(diagnosticPath);
  try {
    await resolveStorageRoot({ path: root, kind: 'interactive' });
    await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [
        CANDIDATE_ENTRYPOINT,
        '--root',
        root,
        '--expected-root-id',
        mismatchedRootId,
        '--startup-attempt-id',
        startupAttemptId,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );

    assert.equal(result.status, 70, result.stderr);
    const diagnostic = await readCandidateStartupDiagnostic(mismatchedRootId, startupAttemptId);
    assert.ok(diagnostic);
    assert.equal(diagnostic.reason, 'internal_startup_failure');
    assert.equal(diagnostic.startupAttemptId, startupAttemptId);
    assert.ok(diagnostic.logs.every((entry) => !entry.includes('startup failed')));
    assert.ok(diagnostic.errorChain.some((entry) => entry.code === 'root_identity_changed'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(controlDirectory, { recursive: true, force: true });
  }
});
