import { Buffer } from 'node:buffer';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { IpcMain } from 'electron';
import { decodePetPackManifest, type PetPackManifestV1 } from '@maka/core/pet';
import {
  createPetPackStore,
  PET_PACK_MANIFEST_FILE,
  PET_PACK_MANIFEST_MAX_BYTES,
  PET_PACK_SPRITE_SHEET_MAX_BYTES,
  PetPackStoreError,
  type PetPackStore,
} from '@maka/storage/pet-pack-store';
import type { createMainWindowController } from './main-window.js';

type MainWindowController = Pick<
  ReturnType<typeof createMainWindowController>,
  'showOpenDialog'
>;

export type PetPackImportFailureReason =
  | 'cancelled'
  | 'invalid_directory'
  | 'invalid_manifest'
  | 'invalid_asset'
  | 'already_installed'
  | 'read_failed';

export type PetPackImportResult =
  | { readonly ok: true; readonly manifest: PetPackManifestV1 }
  | { readonly ok: false; readonly reason: PetPackImportFailureReason };

export class PetPackImportError extends Error {
  readonly reason: Exclude<PetPackImportFailureReason, 'cancelled'>;

  constructor(
    reason: Exclude<PetPackImportFailureReason, 'cancelled'>,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PetPackImportError';
    this.reason = reason;
  }
}

/**
 * Snapshot one code-free PetPack directory selected by the native file picker.
 * The manifest decides which single sprite asset is read; neither path is ever
 * accepted from the renderer.
 */
export async function importPetPackFromDirectory(input: {
  readonly sourceDirectory: string;
  readonly store: PetPackStore;
}): Promise<PetPackManifestV1> {
  const sourceRoot = await admitSourceDirectory(input.sourceDirectory);
  const manifest = await readSourceManifest(sourceRoot);
  const spriteSheet = await readSourceAsset(sourceRoot, manifest);

  try {
    return await input.store.install({ manifest, spriteSheet });
  } catch (error) {
    if (error instanceof PetPackStoreError) {
      if (error.code === 'already_installed') {
        throw new PetPackImportError('already_installed', error.message, { cause: error });
      }
      if (error.code === 'invalid_asset') {
        throw new PetPackImportError('invalid_asset', error.message, { cause: error });
      }
    }
    throw new PetPackImportError('read_failed', 'Unable to install the selected pet pack', {
      cause: error,
    });
  }
}

export function registerPetPackIpc(input: {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly workspaceRoot: string;
  readonly mainWindowController: MainWindowController;
  readonly store?: PetPackStore;
}): void {
  const store = input.store ?? createPetPackStore(input.workspaceRoot);

  input.ipcMain.handle('pets:list', () => store.list());
  input.ipcMain.handle('pets:importLocalDirectory', async (): Promise<PetPackImportResult> => {
    const selection = await input.mainWindowController.showOpenDialog({
      title: 'Import custom pet',
      properties: ['openDirectory'],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { ok: false, reason: 'cancelled' };
    }

    try {
      const manifest = await importPetPackFromDirectory({
        sourceDirectory: selection.filePaths[0],
        store,
      });
      return { ok: true, manifest };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof PetPackImportError ? error.reason : 'read_failed',
      };
    }
  });
}

async function admitSourceDirectory(sourceDirectory: string): Promise<string> {
  try {
    const metadata = await lstat(sourceDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Selected pet pack source is not a plain directory');
    }
    return await realpath(sourceDirectory);
  } catch (error) {
    throw new PetPackImportError(
      'invalid_directory',
      'Selected pet pack source is not a readable directory',
      { cause: error },
    );
  }
}

async function readSourceManifest(sourceRoot: string): Promise<PetPackManifestV1> {
  try {
    const bytes = await readBoundedSourceFile(
      sourceRoot,
      PET_PACK_MANIFEST_FILE,
      PET_PACK_MANIFEST_MAX_BYTES,
    );
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decodePetPackManifest(JSON.parse(text));
  } catch (error) {
    throw new PetPackImportError('invalid_manifest', 'Selected pet manifest is invalid', {
      cause: error,
    });
  }
}

async function readSourceAsset(
  sourceRoot: string,
  manifest: PetPackManifestV1,
): Promise<Uint8Array> {
  try {
    return await readBoundedSourceFile(
      sourceRoot,
      manifest.spriteSheet.path,
      PET_PACK_SPRITE_SHEET_MAX_BYTES,
    );
  } catch (error) {
    throw new PetPackImportError('invalid_asset', 'Selected pet sprite sheet is invalid', {
      cause: error,
    });
  }
}

async function readBoundedSourceFile(
  sourceRoot: string,
  relativePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const segments = relativePath.split('/');
  const candidate = join(sourceRoot, ...segments);
  const canonicalPath = await realpath(candidate);
  const fromRoot = relative(sourceRoot, canonicalPath);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Pet pack source file escapes the selected directory');
  }

  let parent = sourceRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Pet pack source path contains a redirected directory');
    }
  }

  const before = await lstat(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) {
    throw new Error(`Pet pack source file must be a regular file no larger than ${maxBytes} bytes`);
  }

  const handle = await open(candidate, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Pet pack source file changed while opening');
    }
    const output = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Pet pack source file exceeds ${maxBytes} bytes`);
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
