import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PET_PACK_SCHEMA_V1 } from '@maka/core/pet';
import {
  PET_PACK_DIRECTORY,
  PET_PACK_MANIFEST_FILE,
  PET_PACK_SPRITE_SHEET_MAX_BYTES,
  PetPackStoreError,
  createPetPackStore,
} from '../pet-pack-store.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: PET_PACK_SCHEMA_V1,
    id: 'likun.maodie',
    displayName: '我的耄耋',
    description: 'A user-installed custom pet.',
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

describe('PetPackStore', () => {
  test('atomically installs, lists, reads, and removes a custom pet', async () => {
    await withStore(async ({ root, store }) => {
      const installed = await store.install({
        manifest: manifest(),
        spriteSheet: pngHeader(64, 64),
      });
      assert.equal(installed.id, 'likun.maodie');
      assert.deepEqual(
        (await store.list()).map((item) => item.id),
        ['likun.maodie'],
      );
      assert.equal((await store.get('likun.maodie'))?.displayName, '我的耄耋');

      const asset = await store.readSpriteSheet('likun.maodie');
      assert.equal(asset?.format, 'png');
      assert.deepEqual(Buffer.from(asset?.bytes ?? []), pngHeader(64, 64));

      const packRoot = join(root, ...PET_PACK_DIRECTORY.split('/'), 'likun.maodie');
      assert.equal(
        JSON.parse(await readFile(join(packRoot, PET_PACK_MANIFEST_FILE), 'utf8')).id,
        'likun.maodie',
      );
      assert.deepEqual(
        (await readdir(join(root, ...PET_PACK_DIRECTORY.split('/')))).filter((name) =>
          name.startsWith('.install-'),
        ),
        [],
      );

      assert.equal(await store.remove('likun.maodie'), true);
      assert.equal(await store.remove('likun.maodie'), false);
      assert.deepEqual(await store.list(), []);
    });
  });

  test('rejects malformed manifests before publishing any directory', async () => {
    await withStore(async ({ root, store }) => {
      const invalid = manifest({ script: 'pet.js' });
      await assert.rejects(store.install({ manifest: invalid, spriteSheet: pngHeader(64, 64) }));
      await assert.rejects(readdir(join(root, ...PET_PACK_DIRECTORY.split('/'))), {
        code: 'ENOENT',
      });
    });
  });

  test('rejects mismatched dimensions, invalid headers, and oversized assets', async () => {
    await withStore(async ({ store }) => {
      await assert.rejects(
        store.install({ manifest: manifest(), spriteSheet: pngHeader(32, 64) }),
        isStoreError('invalid_asset'),
      );
      await assert.rejects(
        store.install({ manifest: manifest(), spriteSheet: Buffer.from('not an image') }),
        isStoreError('invalid_asset'),
      );
      await assert.rejects(
        store.install({
          manifest: manifest(),
          spriteSheet: new Uint8Array(PET_PACK_SPRITE_SHEET_MAX_BYTES + 1),
        }),
        isStoreError('invalid_asset'),
      );
      assert.deepEqual(await store.list(), []);
    });
  });

  test('never replaces an installed pet with the same id', async () => {
    await withStore(async ({ store }) => {
      await store.install({ manifest: manifest(), spriteSheet: pngHeader(64, 64) });
      await assert.rejects(
        store.install({
          manifest: manifest({ displayName: 'Replacement' }),
          spriteSheet: pngHeader(64, 64),
        }),
        isStoreError('already_installed'),
      );
      assert.equal((await store.get('likun.maodie'))?.displayName, '我的耄耋');
    });
  });

  test('snapshots caller-owned manifest and image bytes before waiting for publication', async () => {
    await withStore(async ({ store }) => {
      const mutableManifest = manifest({ id: 'likun.snapshot' });
      const mutableSprite = pngHeader(64, 64);
      const install = store.install({
        manifest: mutableManifest,
        spriteSheet: mutableSprite,
      });
      mutableManifest.displayName = 'Mutated after admission';
      mutableSprite.fill(0);

      await install;
      assert.equal((await store.get('likun.snapshot'))?.displayName, '我的耄耋');
      assert.deepEqual(
        Buffer.from((await store.readSpriteSheet('likun.snapshot'))?.bytes ?? []),
        pngHeader(64, 64),
      );
    });
  });

  test('rejects non-canonical ids at every direct lookup boundary', async () => {
    await withStore(async ({ store }) => {
      await assert.rejects(store.get('../maodie'), isStoreError('invalid_id'));
      await assert.rejects(store.readSpriteSheet('/tmp/maodie'), isStoreError('invalid_id'));
      await assert.rejects(store.remove('MAODIE'), isStoreError('invalid_id'));
    });
  });

  test('detects sprite sheets redirected outside the installed pack', {
    skip:
      process.platform === 'win32'
        ? 'Windows file-symlink permissions are not guaranteed in CI'
        : false,
  }, async () => {
    await withStore(async ({ root, store }) => {
      await store.install({ manifest: manifest(), spriteSheet: pngHeader(64, 64) });
      const packRoot = join(root, ...PET_PACK_DIRECTORY.split('/'), 'likun.maodie');
      const assetPath = join(packRoot, 'assets', 'maodie.png');
      const outsidePath = join(root, 'outside.png');
      await writeFile(outsidePath, pngHeader(64, 64));
      await rm(assetPath);
      await symlink(outsidePath, assetPath);

      await assert.rejects(store.readSpriteSheet('likun.maodie'), isStoreError('corrupt_pack'));
    });
  });

  test('rejects a store root redirected outside the state root', async () => {
    await withStore(async ({ root, store }) => {
      const outside = await mkdtemp(join(tmpdir(), 'maka-pet-pack-outside-'));
      try {
        await symlink(
          outside,
          join(root, 'pets'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        await assert.rejects(store.list(), isStoreError('corrupt_store'));
        await assert.rejects(
          store.install({ manifest: manifest(), spriteSheet: pngHeader(64, 64) }),
          isStoreError('corrupt_store'),
        );
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(join(root, 'pets'), { force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

function isStoreError(code: PetPackStoreError['code']): (error: unknown) => boolean {
  return (error) => error instanceof PetPackStoreError && error.code === code;
}

async function withStore(
  run: (input: { root: string; store: ReturnType<typeof createPetPackStore> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pet-pack-store-'));
  try {
    await run({ root, store: createPetPackStore(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
