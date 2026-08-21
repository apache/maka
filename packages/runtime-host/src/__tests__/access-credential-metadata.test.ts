import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRuntimeHostAccessCredentialMetadata } from '../server/access-credential-metadata.js';

test('credential metadata inspection does not create missing State Roots', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'maka-access-metadata-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  for (const expectedRootId of [undefined, 'a'.repeat(64)]) {
    const root = join(parent, expectedRootId ? 'expected' : 'discovered');
    await assert.rejects(readRuntimeHostAccessCredentialMetadata(root, expectedRootId));
    await assert.rejects(access(root));
  }
});
