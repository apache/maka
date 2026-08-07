import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PET_PACK_SCHEMA_V1 } from '@maka/core/pet';
import { createPetPackStore } from '@maka/storage/pet-pack-store';
import {
  importPetPackFromDirectory,
  PetPackImportError,
  registerPetPackIpc,
} from '../pet-pack-import.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: PET_PACK_SCHEMA_V1,
    id: 'likun.maodie',
    displayName: '我的耄耋',
    spriteSheet: {
      path: 'assets/maodie.png',
      format: 'png',
      frameWidth: 32,
      frameHeight: 32,
      columns: 2,
      rows: 2,
      frameCount: 4,
    },
    animations: {
      idle: { frames: [0], fps: 2, loop: true },
      working: { frames: [1], fps: 4, loop: true },
      'needs-input': { frames: [2], fps: 2, loop: true },
      ready: { frames: [3], fps: 4, loop: false, fallback: 'idle' },
      blocked: { frames: [2], fps: 2, loop: true },
    },
    ...overrides,
  };
}

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('imports only the manifest-selected sprite into the atomic store', async () => {
  await withFixture(async ({ source, stateRoot }) => {
    await writeSourcePack(source);
    const store = createPetPackStore(stateRoot);

    const installed = await importPetPackFromDirectory({ sourceDirectory: source, store });

    assert.equal(installed.id, 'likun.maodie');
    assert.deepEqual((await store.list()).map(({ id }) => id), ['likun.maodie']);
    assert.deepEqual(
      Buffer.from((await store.readSpriteSheet('likun.maodie'))?.bytes ?? []),
      pngHeader(64, 64),
    );
  });
});

test('rejects malformed manifests and leaves the store empty', async () => {
  await withFixture(async ({ source, stateRoot }) => {
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'pet.json'), '{"schema":');
    await writeFile(join(source, 'assets', 'maodie.png'), pngHeader(64, 64));
    const store = createPetPackStore(stateRoot);

    await assert.rejects(
      importPetPackFromDirectory({ sourceDirectory: source, store }),
      isImportError('invalid_manifest'),
    );
    assert.deepEqual(await store.list(), []);
  });
});

test('rejects a sprite symlink that redirects outside the selected directory', async (context) => {
  if (process.platform === 'win32') {
    context.skip('symlink creation is not reliably available on Windows CI');
    return;
  }
  await withFixture(async ({ root, source, stateRoot }) => {
    const outside = join(root, 'outside.png');
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'pet.json'), JSON.stringify(manifest()));
    await writeFile(outside, pngHeader(64, 64));
    await symlink(outside, join(source, 'assets', 'maodie.png'));

    await assert.rejects(
      importPetPackFromDirectory({
        sourceDirectory: source,
        store: createPetPackStore(stateRoot),
      }),
      isImportError('invalid_asset'),
    );
  });
});

test('rejects a symlinked asset directory even when it points back inside the source', async (context) => {
  if (process.platform === 'win32') {
    context.skip('symlink creation is not reliably available on Windows CI');
    return;
  }
  await withFixture(async ({ source, stateRoot }) => {
    const realAssets = join(source, 'real-assets');
    await mkdir(realAssets);
    await writeFile(join(source, 'pet.json'), JSON.stringify(manifest()));
    await writeFile(join(realAssets, 'maodie.png'), pngHeader(64, 64));
    await symlink(realAssets, join(source, 'assets'));

    await assert.rejects(
      importPetPackFromDirectory({
        sourceDirectory: source,
        store: createPetPackStore(stateRoot),
      }),
      isImportError('invalid_asset'),
    );
  });
});

test('maps a duplicate id without replacing the installed pet', async () => {
  await withFixture(async ({ source, stateRoot }) => {
    await writeSourcePack(source);
    const store = createPetPackStore(stateRoot);
    await importPetPackFromDirectory({ sourceDirectory: source, store });
    await writeFile(
      join(source, 'pet.json'),
      JSON.stringify(manifest({ displayName: 'Replacement' })),
    );

    await assert.rejects(
      importPetPackFromDirectory({ sourceDirectory: source, store }),
      isImportError('already_installed'),
    );
    assert.equal((await store.get('likun.maodie'))?.displayName, '我的耄耋');
  });
});

test('IPC imports only the native picker result and returns stable envelopes', async () => {
  await withFixture(async ({ source, stateRoot }) => {
    await writeSourcePack(source);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerPetPackIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
      },
      workspaceRoot: stateRoot,
      mainWindowController: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [source] }),
      },
    });

    const result = await handlers.get('pets:importLocalDirectory')?.({}, '/untrusted/path');
    assert.deepEqual(result, { ok: true, manifest: manifest() });
    assert.deepEqual(await handlers.get('pets:list')?.(), [manifest()]);
  });
});

test('IPC reports picker cancellation without touching storage', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerPetPackIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as (...args: unknown[]) => unknown),
    },
    workspaceRoot: '/unused',
    mainWindowController: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    store: {
      list: async () => [],
      get: async () => undefined,
      install: async () => {
        throw new Error('install must not run');
      },
      readSpriteSheet: async () => undefined,
      remove: async () => false,
    },
  });

  assert.deepEqual(await handlers.get('pets:importLocalDirectory')?.({}), {
    ok: false,
    reason: 'cancelled',
  });
});

async function writeSourcePack(source: string): Promise<void> {
  await mkdir(join(source, 'assets'), { recursive: true });
  await writeFile(join(source, 'pet.json'), JSON.stringify(manifest()));
  await writeFile(join(source, 'assets', 'maodie.png'), pngHeader(64, 64));
  await writeFile(join(source, 'ignored.js'), 'throw new Error("must never execute")');
}

function isImportError(reason: PetPackImportError['reason']): (error: unknown) => boolean {
  return (error) => error instanceof PetPackImportError && error.reason === reason;
}

async function withFixture(
  run: (fixture: { root: string; source: string; stateRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pet-import-'));
  const source = join(root, 'source');
  const stateRoot = join(root, 'state');
  await mkdir(source);
  try {
    await run({ root, source, stateRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
