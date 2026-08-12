import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteArtifactStore } from '@maka/storage';
import { ingestAttachments } from '../attachment-ingest.js';

describe('ingestAttachments', () => {
  test('workspace symlink escaping cwd is snapshotted, not exposed as a live workspace_file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-sym-'));
    const outsideDir = await mkdtemp(join(tmpdir(), 'att-sym-out-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const outsideFile = join(outsideDir, 'secret.md');
      await writeFile(outsideFile, 'secret');
      // symlink inside the workspace that resolves to a file outside it
      const linkPath = join(dir, 'escape.md');
      await symlink(outsideFile, linkPath);
      const refs = await ingestAttachments({
        files: [{ path: linkPath, mimeType: 'text/markdown', size: 6 }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
      });
      assert.equal(refs.length, 1);
      assert.equal(
        refs[0].ref.kind,
        'session_file',
        'a symlink that escapes the workspace must be snapshotted, not read live via workspace_file',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('path attachment grown between stat and read is rejected, no artifact created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-cap-'));
    const externalPath = join(tmpdir(), `grew-${Date.now()}.bin`);
    try {
      const store = createSqliteArtifactStore(dir);
      // real file is 11 bytes; files[].size lies small (TOCTOU: stat said 5)
      await writeFile(externalPath, Buffer.alloc(11));
      let storeCreates = 0;
      const realCreate = store.create.bind(store);
      store.create = async (input) => {
        storeCreates += 1;
        return realCreate(input);
      };
      await assert.rejects(
        ingestAttachments({
          files: [{ path: externalPath, mimeType: 'application/octet-stream', size: 5 }],
          cwd: dir,
          sessionId: 's1',
          artifactStore: store,
          resizeImage: async (b) => b,
          maxBytes: 10,
        }),
        /超出大小限制/,
      );
      assert.equal(storeCreates, 0, 'must not create an artifact for an oversized read');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(externalPath, { force: true });
    }
  });
});
