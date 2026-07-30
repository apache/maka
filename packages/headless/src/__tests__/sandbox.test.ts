import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  freezeSubmittedWorkspace,
  prepareScoringWorkspace,
  prepareWorkspace,
  restoreProtectedPaths,
} from '../sandbox.js';

const execFileAsync = promisify(execFile);

async function withFixture<T>(fn: (fixtureDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-headless-fixture-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('prepareWorkspace', () => {
  test('copies the fixture into a throwaway dir and isolates mutations', async () => {
    await withFixture(async (fixtureDir) => {
      await writeFile(join(fixtureDir, 'app.txt'), 'original', 'utf8');

      const ws = await prepareWorkspace(fixtureDir);
      try {
        // the copy has the fixture content
        assert.equal(await readFile(join(ws.dir, 'app.txt'), 'utf8'), 'original');
        assert.notEqual(ws.dir, fixtureDir);

        // mutating the copy must not touch the source fixture
        await writeFile(join(ws.dir, 'app.txt'), 'mutated', 'utf8');
        await writeFile(join(ws.dir, 'new.txt'), 'added', 'utf8');
        assert.equal(await readFile(join(fixtureDir, 'app.txt'), 'utf8'), 'original');
        await assert.rejects(stat(join(fixtureDir, 'new.txt')));
      } finally {
        await ws.cleanup();
      }
    });
  });

  test('cleanup removes the throwaway dir', async () => {
    await withFixture(async (fixtureDir) => {
      const ws = await prepareWorkspace(fixtureDir);
      await ws.cleanup();
      await assert.rejects(stat(ws.dir));
    });
  });

  test('rejects a fixture containing a symlink', async () => {
    await withFixture(async (fixtureDir) => {
      await writeFile(join(fixtureDir, 'real.txt'), 'x', 'utf8');
      await symlink('/etc/hosts', join(fixtureDir, 'escape'));
      await assert.rejects(prepareWorkspace(fixtureDir), /symlink/);
    });
  });
});

describe('freezeSubmittedWorkspace', () => {
  test('copies portable workspace evidence while skipping process-local special files', {
    skip: process.platform === 'win32',
  }, async () => {
    await withFixture(async (fixtureDir) => {
      const snapshotRoot = await mkdtemp(join(tmpdir(), 'maka-headless-snapshot-'));
      try {
        await writeFile(join(fixtureDir, 'result.txt'), 'submitted', 'utf8');
        await symlink('result.txt', join(fixtureDir, 'result-link'));
        await execFileAsync('mkfifo', [join(fixtureDir, 'agent.pipe')]);

        const frozen = await freezeSubmittedWorkspace({
          workspaceDir: fixtureDir,
          snapshotRoot,
        });

        assert.equal(
          await readFile(join(frozen.submittedSnapshot.snapshotPath, 'result.txt'), 'utf8'),
          'submitted',
        );
        assert.equal(
          await readlink(join(frozen.submittedSnapshot.snapshotPath, 'result-link')),
          'result.txt',
        );
        await assert.rejects(stat(join(frozen.submittedSnapshot.snapshotPath, 'agent.pipe')));

        const scoring = await prepareScoringWorkspace(frozen.submittedSnapshot);
        try {
          assert.equal(await readlink(join(scoring.dir, 'result-link')), 'result.txt');
        } finally {
          await scoring.cleanup();
        }
      } finally {
        await rm(snapshotRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('restoreProtectedPaths', () => {
  test('reverts agent edits to protected files, keeps the rest', async () => {
    await withFixture(async (fixtureDir) => {
      await writeFile(join(fixtureDir, 'test.mjs'), 'ORIGINAL', 'utf8');
      await writeFile(join(fixtureDir, 'src.mjs'), 'src', 'utf8');

      const ws = await prepareWorkspace(fixtureDir);
      try {
        // the agent tampers with both files
        await writeFile(join(ws.dir, 'test.mjs'), 'CHEATED', 'utf8');
        await writeFile(join(ws.dir, 'src.mjs'), 'edited', 'utf8');

        await restoreProtectedPaths(fixtureDir, ws.dir, ['test.mjs']);

        // protected file is back to pristine; the unprotected edit survives
        assert.equal(await readFile(join(ws.dir, 'test.mjs'), 'utf8'), 'ORIGINAL');
        assert.equal(await readFile(join(ws.dir, 'src.mjs'), 'utf8'), 'edited');
      } finally {
        await ws.cleanup();
      }
    });
  });

  test('rejects a protected path that escapes the workspace', async () => {
    await withFixture(async (fixtureDir) => {
      const ws = await prepareWorkspace(fixtureDir);
      try {
        await assert.rejects(restoreProtectedPaths(fixtureDir, ws.dir, ['../escape']), /relative/);
        await assert.rejects(restoreProtectedPaths(fixtureDir, ws.dir, ['/etc/hosts']), /relative/);
      } finally {
        await ws.cleanup();
      }
    });
  });
});
