/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  decodePetPackManifest,
  isPetPackId,
  PetManifestValidationError,
  type PetPackManifestV1,
  type PetSpriteFormat,
} from '@maka/core/pet';

export const PET_PACK_DIRECTORY = 'pets/v1';
export const PET_PACK_MANIFEST_FILE = 'pet.json';
export const PET_PACK_MANIFEST_MAX_BYTES = 64 * 1024;
export const PET_PACK_SPRITE_SHEET_MAX_BYTES = 4 * 1024 * 1024;

export type PetPackStoreErrorCode =
  | 'invalid_id'
  | 'invalid_asset'
  | 'already_installed'
  | 'corrupt_store'
  | 'corrupt_pack'
  | 'io_failed';

export class PetPackStoreError extends Error {
  readonly code: PetPackStoreErrorCode;
  readonly petId?: string;

  constructor(
    code: PetPackStoreErrorCode,
    message: string,
    options: { readonly petId?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PetPackStoreError';
    this.code = code;
    this.petId = options.petId;
  }
}

export interface InstallPetPackInput {
  /** Untrusted JSON value decoded at the caller boundary. */
  readonly manifest: unknown;
  /** Complete PNG or WebP sprite sheet bytes. */
  readonly spriteSheet: Uint8Array;
}

export interface PetSpriteSheetAsset {
  readonly format: PetSpriteFormat;
  readonly bytes: Uint8Array;
}

export interface PetPackStore {
  list(): Promise<readonly PetPackManifestV1[]>;
  get(petId: string): Promise<PetPackManifestV1 | undefined>;
  install(input: InstallPetPackInput): Promise<PetPackManifestV1>;
  readSpriteSheet(petId: string): Promise<PetSpriteSheetAsset | undefined>;
  remove(petId: string): Promise<boolean>;
}

export function createPetPackStore(stateRoot: string): PetPackStore {
  return new FilePetPackStore(stateRoot);
}

class FilePetPackStore implements PetPackStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly petsRoot: string;
  private readonly root: string;

  constructor(private readonly stateRoot: string) {
    this.petsRoot = join(stateRoot, 'pets');
    this.root = join(this.petsRoot, 'v1');
  }

  async list(): Promise<readonly PetPackManifestV1[]> {
    if (!(await this.storeRootExists())) return [];
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw ioFailed('Unable to list installed pet packs', error);
    }

    const manifests: PetPackManifestV1[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue;
      if (!isPetPackId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw corruptPack(entry.name, 'Pet pack root contains an invalid entry');
      }
      manifests.push(await this.readInstalledManifest(entry.name));
    }
    return manifests;
  }

  async get(petId: string): Promise<PetPackManifestV1 | undefined> {
    const admittedId = admitPetId(petId);
    if (!(await this.storeRootExists())) return undefined;
    const packRoot = join(this.root, admittedId);
    try {
      const metadata = await lstat(packRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw corruptPack(admittedId, 'Installed pet pack is not a regular directory');
      }
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      if (error instanceof PetPackStoreError) throw error;
      throw ioFailed(`Unable to inspect pet pack ${admittedId}`, error, admittedId);
    }
    return this.readInstalledManifest(admittedId);
  }

  async install(input: InstallPetPackInput): Promise<PetPackManifestV1> {
    const manifest = snapshotManifest(decodePetPackManifest(input.manifest));
    const spriteSheet = Buffer.from(input.spriteSheet);
    return await this.serial(async () => {
      assertSpriteSheet(manifest, spriteSheet, 'invalid_asset');
      await this.ensureRoot();

      const destination = join(this.root, manifest.id);
      if (await pathExists(destination)) {
        throw new PetPackStoreError(
          'already_installed',
          `Pet pack ${manifest.id} is already installed`,
          { petId: manifest.id },
        );
      }

      const staging = await mkdtemp(join(this.root, '.install-'));
      try {
        if (process.platform !== 'win32') await chmod(staging, 0o700);
        const manifestPath = join(staging, PET_PACK_MANIFEST_FILE);
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });

        const assetPath = storedAssetPath(staging, manifest);
        await mkdir(dirname(assetPath), { recursive: true, mode: 0o700 });
        await writeFile(assetPath, spriteSheet, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') {
          await chmod(manifestPath, 0o600);
          await chmod(assetPath, 0o600);
        }

        try {
          await rename(staging, destination);
        } catch (error) {
          if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY')) {
            throw new PetPackStoreError(
              'already_installed',
              `Pet pack ${manifest.id} is already installed`,
              { petId: manifest.id, cause: error },
            );
          }
          throw error;
        }
        return manifest;
      } catch (error) {
        if (error instanceof PetPackStoreError) throw error;
        throw ioFailed(`Unable to install pet pack ${manifest.id}`, error, manifest.id);
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  async readSpriteSheet(petId: string): Promise<PetSpriteSheetAsset | undefined> {
    const manifest = await this.get(petId);
    if (!manifest) return undefined;
    const packRoot = join(this.root, manifest.id);
    try {
      const bytes = await readBoundedRegularFile(
        storedAssetPath(packRoot, manifest),
        PET_PACK_SPRITE_SHEET_MAX_BYTES,
        packRoot,
      );
      assertSpriteSheet(manifest, bytes, 'corrupt_pack');
      return { format: manifest.spriteSheet.format, bytes: new Uint8Array(bytes) };
    } catch (error) {
      if (error instanceof PetPackStoreError) throw error;
      throw corruptPack(manifest.id, 'Installed pet sprite sheet is unreadable', error);
    }
  }

  remove(petId: string): Promise<boolean> {
    return this.serial(async () => {
      const admittedId = admitPetId(petId);
      if (!(await this.storeRootExists())) return false;
      const destination = join(this.root, admittedId);
      const quarantine = join(this.root, `.remove-${admittedId}-${randomUUID()}`);
      try {
        await rename(destination, quarantine);
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        throw ioFailed(`Unable to unpublish pet pack ${admittedId}`, error, admittedId);
      }
      try {
        await rm(quarantine, { recursive: true });
        return true;
      } catch (error) {
        throw ioFailed(`Unable to remove pet pack ${admittedId}`, error, admittedId);
      }
    });
  }

  private async readInstalledManifest(petId: string): Promise<PetPackManifestV1> {
    const packRoot = join(this.root, petId);
    try {
      const bytes = await readBoundedRegularFile(
        join(packRoot, PET_PACK_MANIFEST_FILE),
        PET_PACK_MANIFEST_MAX_BYTES,
        packRoot,
      );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const manifest = decodePetPackManifest(JSON.parse(text));
      if (manifest.id !== petId) {
        throw corruptPack(petId, 'Installed pet manifest id does not match its directory');
      }
      return manifest;
    } catch (error) {
      if (error instanceof PetPackStoreError) throw error;
      if (
        error instanceof PetManifestValidationError ||
        error instanceof SyntaxError ||
        error instanceof TypeError
      ) {
        throw corruptPack(petId, 'Installed pet manifest is invalid', error);
      }
      throw corruptPack(petId, 'Installed pet manifest is unreadable', error);
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      await ensurePlainDirectory(this.petsRoot);
      await ensurePlainDirectory(this.root);
    } catch (error) {
      if (error instanceof PetPackStoreError) throw error;
      throw ioFailed('Unable to create the pet pack store', error);
    }
  }

  private async storeRootExists(): Promise<boolean> {
    for (const path of [this.petsRoot, this.root]) {
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new PetPackStoreError(
            'corrupt_store',
            'Pet pack store contains a redirected or non-directory root',
          );
        }
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        if (error instanceof PetPackStoreError) throw error;
        throw ioFailed('Unable to inspect the pet pack store', error);
      }
    }
    return true;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function admitPetId(value: unknown): string {
  if (!isPetPackId(value)) {
    throw new PetPackStoreError('invalid_id', 'Pet pack id is not canonical');
  }
  return value;
}

function storedAssetPath(packRoot: string, manifest: PetPackManifestV1): string {
  return join(packRoot, ...manifest.spriteSheet.path.split('/'));
}

async function ensurePlainDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PetPackStoreError(
      'corrupt_store',
      'Pet pack store contains a redirected or non-directory root',
    );
  }
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

function snapshotManifest(manifest: PetPackManifestV1): PetPackManifestV1 {
  const animations: PetPackManifestV1['animations'] = {
    idle: snapshotAnimation(manifest.animations.idle),
    working: snapshotAnimation(manifest.animations.working),
    'needs-input': snapshotAnimation(manifest.animations['needs-input']),
    ready: snapshotAnimation(manifest.animations.ready),
    blocked: snapshotAnimation(manifest.animations.blocked),
    ...(manifest.animations.swarm === undefined
      ? {}
      : { swarm: snapshotAnimation(manifest.animations.swarm) }),
    ...(manifest.animations.cancelled === undefined
      ? {}
      : { cancelled: snapshotAnimation(manifest.animations.cancelled) }),
    ...(manifest.animations.poke === undefined
      ? {}
      : { poke: snapshotAnimation(manifest.animations.poke) }),
    ...(manifest.animations.wake === undefined
      ? {}
      : { wake: snapshotAnimation(manifest.animations.wake) }),
    ...(manifest.animations.sleep === undefined
      ? {}
      : { sleep: snapshotAnimation(manifest.animations.sleep) }),
  };
  return {
    schema: manifest.schema,
    id: manifest.id,
    displayName: manifest.displayName,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    spriteSheet: { ...manifest.spriteSheet },
    animations,
  };
}

function snapshotAnimation(
  animation: PetPackManifestV1['animations']['idle'],
): PetPackManifestV1['animations']['idle'] {
  return {
    frames: [...animation.frames],
    fps: animation.fps,
    loop: animation.loop,
    ...(animation.fallback === undefined ? {} : { fallback: animation.fallback }),
  };
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  containmentRoot: string,
): Promise<Buffer> {
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(containmentRoot),
    realpath(path),
  ]);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error('Pet pack file escapes its package root');
  }

  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) {
    throw new Error(`Pet pack file must be a regular file no larger than ${maxBytes} bytes`);
  }

  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Pet pack file changed while opening');
    }
    const initialSize = Number(opened.size);
    const output = Buffer.allocUnsafe(Math.min(initialSize, maxBytes) + 1);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Pet pack file exceeds ${maxBytes} bytes`);
    return output.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function assertSpriteSheet(
  manifest: PetPackManifestV1,
  bytes: Uint8Array,
  code: Extract<PetPackStoreErrorCode, 'invalid_asset' | 'corrupt_pack'>,
): void {
  if (bytes.byteLength === 0 || bytes.byteLength > PET_PACK_SPRITE_SHEET_MAX_BYTES) {
    throw new PetPackStoreError(
      code,
      `Pet sprite sheet must be between 1 and ${PET_PACK_SPRITE_SHEET_MAX_BYTES} bytes`,
      { petId: manifest.id },
    );
  }
  let dimensions: { readonly width: number; readonly height: number };
  try {
    dimensions = readImageDimensions(Buffer.from(bytes), manifest.spriteSheet.format);
  } catch (error) {
    throw new PetPackStoreError(code, 'Pet sprite sheet has an invalid image header', {
      petId: manifest.id,
      cause: error,
    });
  }
  const expectedWidth = manifest.spriteSheet.frameWidth * manifest.spriteSheet.columns;
  const expectedHeight = manifest.spriteSheet.frameHeight * manifest.spriteSheet.rows;
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new PetPackStoreError(
      code,
      `Pet sprite sheet must be ${expectedWidth}x${expectedHeight}, got ${dimensions.width}x${dimensions.height}`,
      { petId: manifest.id },
    );
  }
}

function readImageDimensions(
  bytes: Buffer,
  format: PetSpriteFormat,
): { readonly width: number; readonly height: number } {
  return format === 'png' ? readPngDimensions(bytes) : readWebpDimensions(bytes);
}

function readPngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, signature.length).equals(signature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Invalid PNG header');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error('Invalid PNG dimensions');
  return { width, height };
}

function readWebpDimensions(bytes: Buffer): { readonly width: number; readonly height: number } {
  if (
    bytes.length < 25 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new Error('Invalid WebP header');
  }
  const declaredSize = bytes.readUInt32LE(4) + 8;
  if (declaredSize !== bytes.length) throw new Error('Invalid WebP container size');

  const chunkType = bytes.toString('ascii', 12, 16);
  const chunkSize = bytes.readUInt32LE(16);
  if (20 + chunkSize > bytes.length) throw new Error('Truncated WebP image chunk');
  if (chunkType === 'VP8X') {
    if (chunkSize < 10 || bytes.length < 30) throw new Error('Invalid VP8X chunk');
    return {
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27),
    };
  }
  if (chunkType === 'VP8 ') {
    if (
      chunkSize < 10 ||
      bytes.length < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      throw new Error('Invalid VP8 key frame');
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunkType === 'VP8L') {
    if (chunkSize < 5 || bytes.length < 25 || bytes[20] !== 0x2f) {
      throw new Error('Invalid VP8L frame');
    }
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
    };
  }
  throw new Error(`Unsupported WebP image chunk ${chunkType}`);
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function corruptPack(petId: string, message: string, cause?: unknown): PetPackStoreError {
  return new PetPackStoreError('corrupt_pack', message, { petId, cause });
}

function ioFailed(message: string, cause: unknown, petId?: string): PetPackStoreError {
  return new PetPackStoreError('io_failed', message, { petId, cause });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
