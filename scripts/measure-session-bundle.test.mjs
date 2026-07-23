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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DECISION_READY_MIN_SAMPLES,
  hashManifestFiles,
  isDecisionReady,
  measureChildReady,
  redactText,
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

test('bundle creation streams files instead of concatenating the full tar in memory', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.doesNotMatch(source, /Buffer\.concat\(/);
  assert.match(source, /createReadStream/);
  assert.match(source, /createZstdCompress/);
});

async function createRealSessionExport(storageRoot, workspace) {
  const harborCellUrl = new URL('../packages/headless/dist/harbor-cell.js', import.meta.url).href;
  const outputDir = join(storageRoot, 'fixture-output');
  const source = `
    import { runHarborCell } from ${JSON.stringify(harborCellUrl)};
    await runHarborCell({
      config: {
        id: 'restored-session-fixture',
        backend: 'fake',
        llmConnectionSlug: 'fixture',
        model: 'fixture-model',
      },
      instruction: 'preserve this restored history',
      cwd: ${JSON.stringify(workspace)},
      outputDir: ${JSON.stringify(outputDir)},
      storageRoot: ${JSON.stringify(storageRoot)},
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
