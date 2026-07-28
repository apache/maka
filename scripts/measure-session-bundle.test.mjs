import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DECISION_READY_MIN_SAMPLES,
  hashManifestFiles,
  isDecisionReady,
  isBootstrapDecisionReady,
  measureChildReady,
  redactText,
  sanitizeJsonFile,
  writeTarFile,
} from './measure-session-bundle.mjs';

const scriptPath = fileURLToPath(new URL('./measure-session-bundle.mjs', import.meta.url));

test('session bundle measurement rebuilds root authority during fresh-process bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-script-test-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await mkdir(join(root, 'src', '.git', 'objects'), { recursive: true });
    await mkdir(join(root, 'src', 'node_modules', 'fixture'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(join(root, 'src', '说明.txt'), 'unicode path\n');
    await writeFile(join(root, '.env'), 'API_KEY=should-not-enter-the-bundle\n');
    await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=should-not-enter\n');
    await writeFile(join(root, '.netrc'), 'machine example login user password secret\n');
    await writeFile(join(root, '.git-credentials'), 'https://user:secret@example.test\n');
    await mkdir(join(root, '.docker'), { recursive: true });
    await writeFile(join(root, '.docker', 'config.json'), '{"auths":{"example":{}}}\n');
    await mkdir(join(root, '.config', 'gcloud'), { recursive: true });
    await writeFile(
      join(root, '.config', 'gcloud', 'application_default_credentials.json'),
      '{"client_secret":"should-not-enter"}\n',
    );
    await writeFile(join(root, 'src', 'debug.log'), 'Authorization: Bearer should-not-enter\n');
    await writeFile(join(root, '.git', 'objects', 'pack'), 'excluded git bytes\n');
    await writeFile(
      join(root, 'src', '.git', 'objects', 'nested-pack'),
      'excluded nested git bytes\n',
    );
    await writeFile(
      join(root, 'src', 'node_modules', 'fixture', 'index.js'),
      'excluded dependency bytes\n',
    );
    const output = await run([
      scriptPath,
      '--workspace',
      root,
      '--iterations',
      '1',
      '--provider-ttfb-ms',
      '0',
    ]);
    const report = JSON.parse(output);

    assert.equal(report.schemaVersion, 2);
    assert.equal(report.evidence.kind, 'fake-bootstrap-smoke-only');
    assert.equal(report.evidence.decisionReady, false);
    assert.equal(report.evidence.decisionReadyMinSamples, DECISION_READY_MIN_SAMPLES);
    assert.equal(report.evidence.sampleCount, 1);
    assert.equal(report.archive.format, 'tar.zst');
    assert.ok(report.workspace.categories.git > 0);
    assert.ok(report.workspace.categories.nodeModules > 0);
    assert.ok(report.workspace.categories.sensitive > 0);
    assert.equal(
      report.workspace.rawBytes,
      Object.values(report.workspace.categories).reduce((total, bytes) => total + bytes, 0),
    );
    assert.ok(report.workspace.archivedPortableRawBytes > 0);
    assert.equal(
      report.workspace.archivedPortableRawBytes,
      Buffer.byteLength('{"name":"fixture"}\n') +
        Buffer.byteLength('export const answer = 42;\n') +
        Buffer.byteLength('unicode path\n'),
    );
    assert.ok(report.archive.zstdBytes.p50 > 0);
    assert.ok(report.coldStart.freshProcessBootstrapMs.p50 > 0);
    assert.ok(report.samples[0].rawTarBytes > report.samples[0].compressedBytes.zstd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects repeated smoke iterations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-iterations-test-'));
  try {
    const error = await runFailure([scriptPath, '--workspace', root, '--iterations', '2']);
    assert.match(error, /--iterations must be 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects duplicate real export paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-duplicate-export-test-'));
  try {
    const error = await runFailure([
      scriptPath,
      '--workspace',
      root,
      '--session-export',
      root,
      '--session-export',
      root,
    ]);
    assert.match(error, /each --session-export path must be unique/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects export paths that resolve to the same directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-symlink-export-test-'));
  const alias = `${root}-alias`;
  try {
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const error = await runFailure([
      scriptPath,
      '--workspace',
      root,
      '--session-export',
      root,
      '--session-export',
      alias,
    ]);
    assert.match(error, /each --session-export path must be unique/);
  } finally {
    await rm(alias, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects copied exports with the same session identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-duplicate-session-test-'));
  const workspace = join(root, 'workspace');
  const exports = [join(root, 'export-a'), join(root, 'export-b')];
  try {
    await mkdir(workspace, { recursive: true });
    for (const sessionExport of exports) {
      const sessionDir = join(sessionExport, 'sessions', 'session-shared');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'session.jsonl'), '{}\n');
    }
    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      exports[0],
      '--session-export',
      exports[1],
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /each --session-export must contain a unique session id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects overlapping workspace and export roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-overlap-test-'));
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

test('session bundle measurement binds each real export to its paired workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-paired-workspace-test-'));
  const workspaces = [join(root, 'workspace-a'), join(root, 'workspace-b')];
  const exports = [join(root, 'export-a'), join(root, 'export-b')];
  try {
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));
    await writeFile(join(workspaces[0], 'workspace-a.txt'), 'a\n');
    await writeFile(join(workspaces[1], 'workspace-b.txt'), 'workspace b\n');
    await Promise.all(
      exports.map((sessionExport, index) =>
        createRealSessionExport(sessionExport, workspaces[index]),
      ),
    );

    const report = JSON.parse(
      await run([
        scriptPath,
        '--workspace',
        workspaces[0],
        '--workspace',
        workspaces[1],
        '--session-export',
        exports[0],
        '--session-export',
        exports[1],
        '--iterations',
        '2',
        '--boot-samples',
        '1',
      ]),
    );

    assert.equal(report.evidence.decisionReady, false);
    assert.equal(report.evidence.workspacePairing, 'one-to-one');
    assert.equal(report.samples.length, 2);
    assert.match(report.samples[0].workspace.root, /workspace-a$/);
    assert.match(report.samples[1].workspace.root, /workspace-b$/);
    assert.notEqual(
      report.samples[0].workspace.archivedPortableRawBytes,
      report.samples[1].workspace.archivedPortableRawBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared workspace evidence is not decision-ready for multiple real exports', () => {
  assert.equal(
    isDecisionReady('sanitized-real-session-exports', DECISION_READY_MIN_SAMPLES, 1, 100),
    false,
  );
  assert.equal(
    isDecisionReady(
      'sanitized-real-session-exports',
      DECISION_READY_MIN_SAMPLES,
      DECISION_READY_MIN_SAMPLES,
      DECISION_READY_MIN_SAMPLES,
    ),
    true,
  );
});

test('session bundle measurement omits provider estimate without explicit TTFB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-ttfb-test-'));
  try {
    const report = JSON.parse(await run([scriptPath, '--workspace', root, '--boot-samples', '1']));
    assert.equal(report.coldStart.providerTtfbMs, null);
    assert.equal(Object.hasOwn(report.coldStart, 'planningEstimateFirstTokenMs'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects unknown command-line options', async () => {
  const error = await runFailure([scriptPath, '--workpace', process.cwd()]);
  assert.match(error, /Unknown option: --workpace/);
});

test('session bundle measurement rejects literal backslashes in POSIX workspace paths', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-backslash-path-test-'));
  try {
    await writeFile(join(root, 'literal\\backslash.txt'), 'unsupported path\n');
    const error = await runFailure([
      scriptPath,
      '--workspace',
      root,
      '--iterations',
      '1',
      '--provider-ttfb-ms',
      '0',
    ]);
    assert.match(error, /workspace\/session export contains unsupported backslash path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap timing stops at ready while still waiting for clean child exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-ready-timing-test-'));
  try {
    const childPath = join(root, 'ready-child.mjs');
    await writeFile(
      childPath,
      [
        "process.stdout.write('ready\\n');",
        'await new Promise((resolve) => setTimeout(resolve, 500));',
      ].join('\n'),
    );
    const wallStart = performance.now();
    const readyMs = await measureChildReady(process.execPath, [childPath], { cwd: root });
    const wallMs = performance.now() - wallStart;
    assert.ok(wallMs - readyMs >= 300, `ready=${readyMs}ms wall=${wallMs}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest hashing keeps file reads bounded', async () => {
  let active = 0;
  let peak = 0;
  const files = Array.from({ length: 32 }, (_, index) => ({
    path: `workspace/file-${index}.txt`,
    bytes: index,
    sourcePath: `/fixture/file-${index}.txt`,
  }));
  const records = await hashManifestFiles(files, async (sourcePath) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return `hash:${sourcePath}`;
  });

  assert.equal(peak, 1);
  assert.equal(records.length, files.length);
  assert.equal(records[0].sha256, 'hash:/fixture/file-0.txt');
});

test('real-session evidence is decision-ready only at the documented sample threshold', () => {
  assert.equal(isDecisionReady('fake-bootstrap-smoke-only', DECISION_READY_MIN_SAMPLES), false);
  assert.equal(
    isDecisionReady('sanitized-real-session-exports', DECISION_READY_MIN_SAMPLES - 1),
    false,
  );
  assert.equal(isDecisionReady('sanitized-real-session-exports', DECISION_READY_MIN_SAMPLES), true);
});

test('session bundle measurement rejects an export containing multiple sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-multi-session-test-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(root, 'export');
  try {
    await mkdir(workspace, { recursive: true });
    for (const sessionId of ['session-a', 'session-b']) {
      const sessionDir = join(sessionExport, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, 'session.jsonl'), '{}\n');
    }
    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /must contain exactly one sessions\/<id>\/session\.jsonl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects protected state entries in an export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-protected-export-test-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(root, 'export');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(join(sessionExport, 'sessions', 'session-protected'), { recursive: true });
    await writeFile(join(sessionExport, 'sessions', 'session-protected', 'session.jsonl'), '{}\n');
    await writeFile(join(sessionExport, 'credentials.json'), '{"token":"must-not-enter"}\n');
    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /protected or unclassified state entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects nested entries under runtime.sqlite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-nested-runtime-test-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(root, 'export');
  try {
    await mkdir(workspace, { recursive: true });
    await createRealSessionExport(sessionExport, workspace);
    await rm(join(sessionExport, 'runtime.sqlite'), { force: true });
    await mkdir(join(sessionExport, 'runtime.sqlite'), { recursive: true });
    await writeFile(join(sessionExport, 'runtime.sqlite', 'credentials.json'), 'must reject\n');
    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /protected or unclassified state entry/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects artifact metadata outside the selected session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-artifact-metadata-test-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(root, 'export');
  try {
    await mkdir(workspace, { recursive: true });
    await createRealSessionExport(sessionExport, workspace);
    const [sessionId] = await readdir(join(sessionExport, 'sessions'));
    await mkdir(join(sessionExport, 'artifacts'), { recursive: true });
    await writeFile(
      join(sessionExport, 'artifacts', 'metadata.jsonl'),
      `${JSON.stringify({ sessionId, relativePath: 'other-session/secret.txt' })}\n`,
    );
    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /unfiltered artifact metadata/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh-process bootstrap fails closed on corrupt restored-session history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-restored-history-test-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(root, 'export');
  try {
    await mkdir(workspace, { recursive: true });
    await createRealSessionExport(sessionExport, workspace);
    const sessionIds = await readdir(join(sessionExport, 'sessions'));
    assert.equal(sessionIds.length, 1);
    await appendFile(
      join(sessionExport, 'sessions', sessionIds[0], 'session.jsonl'),
      '{not-valid-json}\n',
    );

    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /corrupt JSONL record|invalid JSON/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('defense-in-depth redaction preserves ordinary token and secret prose', () => {
  assert.equal(
    redactText('reduce token usage and explain secret handling'),
    'reduce token usage and explain secret handling',
  );
  assert.equal(redactText('token = top-secret'), 'token = [REDACTED]');
});

test('JSON sanitization preserves unchanged compact bytes and compacts redacted JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-json-sanitize-test-'));
  try {
    const unchanged = join(root, 'unchanged.json');
    const unchangedOutput = join(root, 'unchanged-output.json');
    const compact = '{"answer":42}\n';
    await writeFile(unchanged, compact);
    await sanitizeJsonFile(unchanged, unchangedOutput);
    assert.equal(await readFile(unchangedOutput, 'utf8'), compact);

    const redacted = join(root, 'redacted.json');
    const redactedOutput = join(root, 'redacted-output.json');
    await writeFile(redacted, '{\n  "token": "secret-value",\n  "answer": 42\n}\n');
    await sanitizeJsonFile(redacted, redactedOutput);
    assert.equal(await readFile(redactedOutput, 'utf8'), '{"token":"[REDACTED]","answer":42}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON sanitization does not preserve duplicate-key source text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-json-duplicate-key-test-'));
  try {
    const source = join(root, 'duplicate.jsonl');
    const output = join(root, 'duplicate-output.jsonl');
    await writeFile(source, '{"note":"Authorization: Bearer secret-value","note":"safe"}\n');
    await sanitizeJsonFile(source, output);
    const sanitized = await readFile(output, 'utf8');
    assert.equal(sanitized, '{"note":"safe"}\n');
    assert.doesNotMatch(sanitized, /secret-value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON sanitization rejects oversized plain JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-json-size-test-'));
  try {
    const source = join(root, 'large.json');
    await writeFile(source, `{"value":"${'x'.repeat(1_048_576)}"}`);
    await assert.rejects(
      sanitizeJsonFile(source, join(root, 'output.json')),
      /JSON file exceeds maximum size/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap decision readiness requires a controlled Linux build identity', () => {
  assert.equal(isBootstrapDecisionReady(undefined), false);
  assert.equal(
    isBootstrapDecisionReady('build-2026-07-28', {
      node: 'v24.18.0',
      platform: 'linux',
      arch: 'x64',
    }),
    true,
  );
  assert.equal(
    isBootstrapDecisionReady('build-2026-07-28', {
      node: 'v26.0.0',
      platform: 'darwin',
      arch: 'arm64',
    }),
    false,
  );
});

test('bundle creation streams file bytes and retries injected short writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-tar-stream-test-'));
  try {
    const sourcePath = join(root, 'source.txt');
    const payload = Buffer.from('streamed payload through the real tar data path\n');
    await writeFile(sourcePath, payload);
    let output = Buffer.alloc(0);
    let writeCalls = 0;
    const handle = {
      async write(bytes, offset, length, position) {
        writeCalls += 1;
        const count = Math.min(7, length);
        const end = position + count;
        if (end > output.length) {
          const next = Buffer.alloc(end);
          output.copy(next);
          output = next;
        }
        bytes.copy(output, position, offset, offset + count);
        return { bytesWritten: count };
      },
      async close() {},
    };
    let readerCalls = 0;
    await writeTarFile(
      join(root, 'bundle.tar'),
      [{ path: 'workspace/streamed.txt', sourcePath, bytes: payload.byteLength }],
      {
        openFile: async () => handle,
        readFileChunks: async function* (path) {
          readerCalls += 1;
          const bytes = await readFile(path);
          yield bytes.subarray(0, 9);
          yield bytes.subarray(9);
        },
      },
    );

    assert.equal(readerCalls, 1);
    assert.ok(writeCalls > 10, `expected short writes to be retried, got ${writeCalls}`);
    assert.deepEqual(output.subarray(512, 512 + payload.byteLength), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bundle creation rejects a source that changes size during tar streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-tar-size-test-'));
  try {
    const sourcePath = join(root, 'source.txt');
    await writeFile(sourcePath, 'original');
    await assert.rejects(
      writeTarFile(join(root, 'bundle.tar'), [
        { path: 'workspace/source.txt', sourcePath, bytes: 99 },
      ]),
      /tar source size changed during streaming/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRealSessionExport(storageRoot, workspace) {
  const harborCellUrl = new URL('../packages/headless/dist/harbor-cell.js', import.meta.url).href;
  const storageSourceRoot = `${storageRoot}-raw`;
  const outputDir = join(dirname(storageSourceRoot), `${basename(storageSourceRoot)}-output`);
  const source = `
    import { runHarborCell } from ${JSON.stringify(harborCellUrl)};
    import { exportSessionBundleState } from '@maka/storage';
    const result = await runHarborCell({
      config: {
        id: 'restored-session-fixture',
        backend: 'fake',
        llmConnectionSlug: 'fixture',
        model: 'fixture-model',
      },
      instruction: 'preserve this restored history',
      cwd: ${JSON.stringify(workspace)},
      outputDir: ${JSON.stringify(outputDir)},
      storageRoot: ${JSON.stringify(storageSourceRoot)},
    });
    await exportSessionBundleState({
      stateRoot: ${JSON.stringify(storageSourceRoot)},
      configRoot: ${JSON.stringify(storageSourceRoot)},
      destinationRoot: ${JSON.stringify(storageRoot)},
      sessionId: result.invocation.sessionId,
      allowShared: true,
    });
  `;
  await run(['--input-type=module', '--eval', source]);
}

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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) reject(new Error('measurement unexpectedly succeeded'));
      else resolve(stderr);
    });
  });
}
