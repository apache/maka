import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSqliteArtifactStore } from '@maka/storage';
import { ingestAttachments } from '../attachment-ingest.js';

describe('ingestAttachments', () => {
  test('image: resizes, snapshots to ArtifactStore, returns session_file ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-img-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const imagePath = join(dir, 'screen.png');
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await writeFile(imagePath, imageBytes);
      let resizeCalls = 0;
      const refs = await ingestAttachments({
        files: [{ path: imagePath, mimeType: 'image/png', size: imageBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'image');
      assert.equal(refs[0].mimeType, 'image/png');
      assert.equal(refs[0].ref.kind, 'session_file');
      assert.equal(resizeCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('pasted image blob without a file path snapshots from provided bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-clip-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      let resizeCalls = 0;
      const refs = await ingestAttachments({
        files: [{
          name: 'clipboard.png',
          mimeType: 'image/png',
          size: imageBytes.length,
          content: imageBytes,
        } as never],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'image');
      assert.equal(refs[0].name, 'clipboard.png');
      assert.equal(refs[0].mimeType, 'image/png');
      assert.equal(refs[0].bytes, imageBytes.length);
      assert.equal(refs[0].ref.kind, 'session_file');
      assert.equal(resizeCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('workspace non-image: returns workspace_file ref without copying or resizing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-ws-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const codePath = join(dir, 'main.ts');
      const codeBytes = Buffer.from('const x = 1;');
      await writeFile(codePath, codeBytes);
      let resizeCalls = 0;
      let storeCreates = 0;
      const realCreate = store.create.bind(store);
      store.create = async (input) => {
        storeCreates += 1;
        return realCreate(input);
      };
      const refs = await ingestAttachments({
        files: [{ path: codePath, mimeType: 'text/typescript', size: codeBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'code');
      assert.equal(refs[0].ref.kind, 'workspace_file');
      assert.equal((refs[0].ref as { relativePath: string }).relativePath, 'main.ts');
      assert.equal(resizeCalls, 0);
      assert.equal(storeCreates, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('external non-image: snapshots to ArtifactStore without resizing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'att-ext-'));
    try {
      const store = createSqliteArtifactStore(dir);
      const externalPath = join(tmpdir(), `external-${Date.now()}.pdf`);
      const pdfBytes = Buffer.from('%PDF-1.4 fake');
      await writeFile(externalPath, pdfBytes);
      let resizeCalls = 0;
      const refs = await ingestAttachments({
        files: [{ path: externalPath, mimeType: 'application/pdf', size: pdfBytes.length }],
        cwd: dir,
        sessionId: 's1',
        artifactStore: store,
        resizeImage: async (b) => {
          resizeCalls += 1;
          return b;
        },
      });
      assert.equal(refs.length, 1);
      assert.equal(refs[0].kind, 'pdf');
      assert.equal(refs[0].ref.kind, 'session_file');
      assert.equal(resizeCalls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
