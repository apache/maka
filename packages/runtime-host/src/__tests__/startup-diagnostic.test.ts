import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';
import {
  clearCandidateStartupDiagnostic,
  readCandidateStartupDiagnostic,
  resolveCandidateStartupDiagnosticPath,
  writeCandidateStartupDiagnostic,
} from '../control/startup-diagnostic.js';

test('preserves a bounded redacted Candidate startup diagnostic in the private control root', async () => {
  const rootId = createHash('sha256').update(randomUUID()).digest('hex');
  const path = resolveCandidateStartupDiagnosticPath(rootId);
  const controlDirectory = dirname(path);
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
  try {
    const helperDiagnostic = JSON.stringify({
      schemaVersion: 1,
      helper: 'windows_pipe_acl',
      stderr: JSON.stringify({ stage: 'acl_apply', hresult: -2_147_024_891 }),
    });
    await writeCandidateStartupDiagnostic({
      rootId,
      failure: { reason: 'local_ipc_security_failed' },
      error: new Error('Unable to secure endpoint', { cause: new Error(helperDiagnostic) }),
      logs: [`startup token=sk-${'a'.repeat(24)}`, 'endpoint setup failed'],
    });

    const diagnostic = await readCandidateStartupDiagnostic(rootId);
    assert.ok(diagnostic);
    assert.equal(diagnostic.rootId, rootId);
    assert.equal(diagnostic.reason, 'local_ipc_security_failed');
    assert.match(diagnostic.errorChain[1]?.message ?? '', /windows_pipe_acl/u);
    assert.match(diagnostic.errorChain[1]?.message ?? '', /acl_apply/u);
    assert.deepEqual(diagnostic.logs, ['startup token=[redacted]', 'endpoint setup failed']);
    assert.equal((await stat(path)).mode & 0o077, 0);

    await clearCandidateStartupDiagnostic(rootId);
    assert.equal(await readCandidateStartupDiagnostic(rootId), undefined);
  } finally {
    await rm(controlDirectory, { recursive: true, force: true });
  }
});
