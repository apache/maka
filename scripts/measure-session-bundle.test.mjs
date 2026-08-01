import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DECISION_READY_MIN_SAMPLES,
  isDecisionReady,
  redactText,
  sanitizeJsonFile,
} from './measure-session-bundle.mjs';

const scriptPath = fileURLToPath(new URL('./measure-session-bundle.mjs', import.meta.url));

test('session bundle measurement builds a redacted portable archive in a fresh process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-smoke-'));
  try {
    await mkdir(join(root, 'src', 'node_modules', 'fixture'), { recursive: true });
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(root, '.env'), 'API_KEY=must-not-enter-the-bundle\n');
    await writeFile(join(root, '.git', 'objects', 'pack'), 'excluded git bytes\n');
    await writeFile(
      join(root, 'src', 'node_modules', 'fixture', 'index.js'),
      'excluded dependency bytes\n',
    );

    const report = JSON.parse(
      await run([scriptPath, '--workspace', root, '--iterations', '1', '--provider-ttfb-ms', '0']),
    );

    assert.equal(report.schemaVersion, 2);
    assert.equal(report.evidence.kind, 'fake-bootstrap-smoke-only');
    assert.equal(report.evidence.decisionReady, false);
    assert.equal(report.archive.format, 'tar.zst');
    assert.ok(report.workspace.categories.git > 0);
    assert.ok(report.workspace.categories.nodeModules > 0);
    assert.ok(report.workspace.categories.sensitive > 0);
    assert.equal(
      report.workspace.archivedPortableRawBytes,
      Buffer.byteLength('{"name":"fixture"}\n') + Buffer.byteLength('export const answer = 42;\n'),
    );
    assert.ok(report.archive.zstdBytes.p50 > 0);
    assert.ok(report.coldStart.freshProcessBootstrapMs.p50 > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('only enough sanitized real-session samples are decision-ready', () => {
  assert.equal(isDecisionReady('fake-bootstrap-smoke-only', DECISION_READY_MIN_SAMPLES), false);
  assert.equal(
    isDecisionReady('sanitized-real-session-exports', DECISION_READY_MIN_SAMPLES - 1),
    false,
  );
  assert.equal(isDecisionReady('sanitized-real-session-exports', DECISION_READY_MIN_SAMPLES), true);
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
