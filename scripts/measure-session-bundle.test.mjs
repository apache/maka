import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { redactText, sanitizeJsonFile } from './measure-session-bundle.mjs';

const scriptPath = fileURLToPath(new URL('./measure-session-bundle.mjs', import.meta.url));

test('session bundle measurement rejects overlapping workspace and export roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-overlap-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(workspace, 'session-export');
  try {
    await mkdir(join(sessionExport, 'sessions', 'session-overlap'), { recursive: true });
    await writeFile(join(sessionExport, 'sessions', 'session-overlap', 'session.jsonl'), '{}\n');

    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /workspace and session export roots must not overlap/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle sanitization redacts secrets without rewriting safe JSON', async () => {
  assert.equal(
    redactText('reduce token usage and explain secret handling'),
    'reduce token usage and explain secret handling',
  );
  assert.equal(redactText('token = top-secret'), 'token = [REDACTED]');

  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-sanitize-'));
  try {
    const safe = join(root, 'safe.json');
    const safeOutput = join(root, 'safe-output.json');
    const compact = '{"answer":42}\n';
    await writeFile(safe, compact);
    await sanitizeJsonFile(safe, safeOutput);
    assert.equal(await readFile(safeOutput, 'utf8'), compact);

    const secret = join(root, 'secret.json');
    const secretOutput = join(root, 'secret-output.json');
    await writeFile(secret, '{\n  "token": "secret-value",\n  "answer": 42\n}\n');
    await sanitizeJsonFile(secret, secretOutput);
    assert.equal(await readFile(secretOutput, 'utf8'), '{"token":"[REDACTED]","answer":42}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`measurement exited with ${code ?? signal}: ${stderr}`));
    });
  });
}

function runFailure(args) {
  return run(args).then(
    () => Promise.reject(new Error('measurement unexpectedly succeeded')),
    (error) => error.message,
  );
}
