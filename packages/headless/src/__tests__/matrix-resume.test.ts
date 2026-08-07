import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { resolveStorageRoot, StorageRootAuthorityError } from '@maka/storage/root-authority';
import { readMatrixPriorRecords } from '../matrix-resume.js';

describe('readMatrixPriorRecords', () => {
  test('returns no prior results when the runs root does not exist', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'maka-matrix-resume-'));
    try {
      assert.deepEqual(await readMatrixPriorRecords(outputRoot), []);
      assert.deepEqual(await readdir(outputRoot), []);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test('does not treat unmarked or Interactive roots as empty Headless stores', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-matrix-resume-'));
    try {
      const unmarkedOutput = join(base, 'unmarked-output');
      await mkdir(join(unmarkedOutput, 'runs'), { recursive: true });
      await assert.rejects(
        () => readMatrixPriorRecords(unmarkedOutput),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_unmarked',
      );

      const interactiveOutput = join(base, 'interactive-output');
      await mkdir(interactiveOutput);
      await resolveStorageRoot({ path: join(interactiveOutput, 'runs'), kind: 'interactive' });
      await assert.rejects(
        () => readMatrixPriorRecords(interactiveOutput),
        (error: unknown) =>
          error instanceof StorageRootAuthorityError && error.code === 'root_kind_mismatch',
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
