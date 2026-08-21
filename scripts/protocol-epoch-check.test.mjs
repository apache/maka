import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  changedProtocolFilesBetween,
  EPOCH_FILE,
  epochAtRevision,
  evaluateEpochCheck,
  extractCompatibilityEpoch,
  isHeaderOnlyChange,
} from './protocol-epoch-check.mjs';
import { renderHeader } from './asf-license-headers.mjs';
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

/**
 * The guard asks whether the protocol changed, and uses "a file under the
 * protocol directory was touched" as a conservative proxy. Inserting the ASF
 * license header provably does not change the protocol, and answering it with
 * an epoch bump would tell every peer the wire is incompatible over a comment.
 */
test('exempts a protocol file that only gained the ASF license header', () => {
  const repo = mkdtempSync(join(tmpdir(), 'maka-protocol-epoch-header-'));
  const epochPath = join(repo, EPOCH_FILE);
  const protocolDirectory = dirname(epochPath);
  const runGit = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const runInFixture = (file, args, options) =>
    execFileSync(file, args, { ...options, cwd: repo, encoding: 'utf8' });
  const body = 'export const turn = true;\n';
  const headerOnly = join(protocolDirectory, 'turn.ts');
  const alsoEdited = join(protocolDirectory, 'usage.ts');

  try {
    runGit('init', '--initial-branch=main');
    runGit('config', 'user.email', 'epoch-guard@example.invalid');
    runGit('config', 'user.name', 'Epoch Guard Test');
    mkdirSync(protocolDirectory, { recursive: true });
    writeFileSync(epochPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n');
    writeFileSync(headerOnly, body);
    writeFileSync(alsoEdited, body);
    runGit('add', '.');
    runGit('commit', '-m', 'base');

    writeFileSync(headerOnly, `${renderHeader('block')}\n${body}`);
    writeFileSync(alsoEdited, `${renderHeader('block')}\n${body}export const extra = 1;\n`);
    runGit('add', '.');
    runGit('commit', '-m', 'sweep plus one real edit');

    assert.equal(
      isHeaderOnlyChange(
        'packages/runtime-host/src/protocol/turn.ts',
        'HEAD^',
        'HEAD',
        runInFixture,
      ),
      true,
    );
    assert.equal(
      isHeaderOnlyChange(
        'packages/runtime-host/src/protocol/usage.ts',
        'HEAD^',
        'HEAD',
        runInFixture,
      ),
      false,
    );

    const changed = changedProtocolFilesBetween('HEAD^', 'HEAD', runInFixture).filter(
      (file) => !isHeaderOnlyChange(file, 'HEAD^', 'HEAD', runInFixture),
    );
    assert.deepEqual(changed, ['packages/runtime-host/src/protocol/usage.ts']);

    // The epoch still has to move for the file that gained a real edit.
    const verdict = evaluateEpochCheck({
      baseEpoch: epochAtRevision('HEAD^', runInFixture),
      headEpoch: epochAtRevision('HEAD', runInFixture),
      changedProtocolFiles: changed,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /usage\.ts/);
    assert.equal(verdict.reason.includes('turn.ts'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * `changedProtocolFilesBetween` diffs with `--no-renames`, so an added file has
 * no base revision, a deleted file has no head revision, and a rename is one of
 * each. Each is a protocol change; none may crash the guard that would have
 * demanded an epoch for it.
 */
test('treats added, deleted, and renamed protocol files as real changes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'maka-protocol-epoch-lifecycle-'));
  const epochPath = join(repo, EPOCH_FILE);
  const protocolDirectory = dirname(epochPath);
  const runGit = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const runInFixture = (file, args, options) =>
    execFileSync(file, args, { ...options, cwd: repo, encoding: 'utf8' });
  const withHeader = `${renderHeader('block')}\nexport const value = true;\n`;

  try {
    runGit('init', '--initial-branch=main');
    runGit('config', 'user.email', 'epoch-guard@example.invalid');
    runGit('config', 'user.name', 'Epoch Guard Test');
    mkdirSync(protocolDirectory, { recursive: true });
    writeFileSync(epochPath, 'export const RUNTIME_HOST_COMPATIBILITY_EPOCH = 27 as const;\n');
    writeFileSync(join(protocolDirectory, 'removed.ts'), withHeader);
    writeFileSync(join(protocolDirectory, 'before-rename.ts'), withHeader);
    runGit('add', '.');
    runGit('commit', '-m', 'base');

    writeFileSync(join(protocolDirectory, 'added.ts'), withHeader);
    rmSync(join(protocolDirectory, 'removed.ts'));
    renameSync(
      join(protocolDirectory, 'before-rename.ts'),
      join(protocolDirectory, 'after-rename.ts'),
    );
    runGit('add', '--all');
    runGit('commit', '-m', 'add, delete, and rename protocol files');

    const changed = changedProtocolFilesBetween('HEAD^', 'HEAD', runInFixture);
    assert.deepEqual(changed.sort(), [
      'packages/runtime-host/src/protocol/added.ts',
      'packages/runtime-host/src/protocol/after-rename.ts',
      'packages/runtime-host/src/protocol/before-rename.ts',
      'packages/runtime-host/src/protocol/removed.ts',
    ]);

    for (const file of changed) {
      assert.equal(isHeaderOnlyChange(file, 'HEAD^', 'HEAD', runInFixture), false, file);
    }

    const verdict = evaluateEpochCheck({
      baseEpoch: epochAtRevision('HEAD^', runInFixture),
      headEpoch: epochAtRevision('HEAD', runInFixture),
      changedProtocolFiles: changed.filter(
        (file) => !isHeaderOnlyChange(file, 'HEAD^', 'HEAD', runInFixture),
      ),
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /added\.ts/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
