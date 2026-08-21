import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  changedProtocolFilesBetween,
  EPOCH_FILE,
  epochAtRevision,
  evaluateEpochCheck,
  extractCompatibilityEpoch,
} from './protocol-epoch-check.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('extracts the epoch from the declaration line', () => {
  assert.equal(
    extractCompatibilityEpoch('export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n'),
    27,
  );
});

test('refuses a source with no epoch declaration or more than one', () => {
  assert.throws(() => extractCompatibilityEpoch('export const OTHER = 1 as const;\n'), /found 0/);
  assert.throws(
    () =>
      extractCompatibilityEpoch(
        'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n' +
          'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 28 as const;\n',
      ),
    /found 2/,
  );
});

test('parses the real protocol index, so the pattern cannot silently rot', () => {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(join(repoRoot, EPOCH_FILE), 'utf8');
  assert.equal(Number.isInteger(extractCompatibilityEpoch(source)), true);
});

test('fails a protocol change whose epoch equals the current base parent', () => {
  const verdict = evaluateEpochCheck({
    baseEpoch: 27,
    headEpoch: 27,
    changedProtocolFiles: ['packages/runtime-host/src/protocol/operations.ts'],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /still 27/);
  assert.match(verdict.reason, /operations\.ts/);
});

test('catches sibling same-number bumps against the synthetic merge first parent', () => {
  const repo = mkdtempSync(join(tmpdir(), 'maka-protocol-epoch-graph-'));
  const epochPath = join(repo, EPOCH_FILE);
  const protocolDirectory = dirname(epochPath);
  const runGit = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const runInFixture = (file, args, options) =>
    execFileSync(file, args, { ...options, cwd: repo, encoding: 'utf8' });

  try {
    runGit('init', '--initial-branch=main');
    runGit('config', 'user.email', 'epoch-guard@example.invalid');
    runGit('config', 'user.name', 'Epoch Guard Test');
    mkdirSync(protocolDirectory, { recursive: true });
    writeFileSync(epochPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n');
    runGit('add', '.');
    runGit('commit', '-m', 'base epoch 27');
    runGit('tag', 'fork-point');
    runGit('branch', 'sibling-b');

    writeFileSync(epochPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 28 as const;\n');
    writeFileSync(join(protocolDirectory, 'sibling-a.ts'), 'export const siblingA = true;\n');
    runGit('add', '.');
    runGit('commit', '-m', 'land sibling A at epoch 28');

    runGit('switch', '--quiet', 'sibling-b');
    writeFileSync(epochPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 28 as const;\n');
    writeFileSync(join(protocolDirectory, 'sibling-b.ts'), 'export const siblingB = true;\n');
    runGit('add', '.');
    runGit('commit', '-m', 'prepare sibling B at epoch 28');

    runGit('switch', '--quiet', 'main');
    runGit('merge', '--no-ff', 'sibling-b', '-m', 'synthetic merge');

    const verdictAgainstForkPoint = evaluateEpochCheck({
      baseEpoch: epochAtRevision('fork-point', runInFixture),
      headEpoch: epochAtRevision('HEAD', runInFixture),
      changedProtocolFiles: changedProtocolFilesBetween('fork-point', 'HEAD', runInFixture),
    });
    assert.equal(verdictAgainstForkPoint.ok, true);

    const verdictAgainstCurrentBase = evaluateEpochCheck({
      baseEpoch: epochAtRevision('HEAD^1', runInFixture),
      headEpoch: epochAtRevision('HEAD', runInFixture),
      changedProtocolFiles: changedProtocolFilesBetween('HEAD^1', 'HEAD', runInFixture),
    });
    assert.equal(verdictAgainstCurrentBase.ok, false);
    assert.match(verdictAgainstCurrentBase.reason, /still 28/);
    assert.match(verdictAgainstCurrentBase.reason, /sibling-b\.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fails any epoch decrease, protocol change or not', () => {
  for (const changedProtocolFiles of [[], ['packages/runtime-host/src/protocol/index.ts']]) {
    const verdict = evaluateEpochCheck({ baseEpoch: 28, headEpoch: 27, changedProtocolFiles });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /went backward/);
  }
});

test('passes a protocol change that moves the epoch forward', () => {
  const verdict = evaluateEpochCheck({
    baseEpoch: 27,
    headEpoch: 28,
    changedProtocolFiles: ['packages/runtime-host/src/protocol/index.ts'],
  });
  assert.equal(verdict.ok, true);
});

test('passes when nothing under the protocol directory changed', () => {
  for (const headEpoch of [27, 28]) {
    const verdict = evaluateEpochCheck({ baseEpoch: 27, headEpoch, changedProtocolFiles: [] });
    assert.equal(verdict.ok, true);
  }
});
