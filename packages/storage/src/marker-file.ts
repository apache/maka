import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface MarkerFileHandle {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  readFile(encoding: 'utf8'): Promise<string>;
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface MarkerFileDependencies {
  open(path: string, flags: string | number, mode?: number): Promise<MarkerFileHandle>;
  randomUUID(): string;
}

const defaultDependencies: MarkerFileDependencies = {
  open: async (path, flags, mode) => open(path, flags, mode),
  randomUUID,
};

export interface ReadBoundedMarkerFileInput {
  path: string;
  maxBytes: number;
  invalidFile(): Error;
}

export async function readBoundedMarkerFile(
  input: ReadBoundedMarkerFileInput,
  dependencies: Partial<MarkerFileDependencies> = {},
): Promise<string> {
  const deps = { ...defaultDependencies, ...dependencies };
  const handle = await deps.open(input.path, markerReadFlags());
  try {
    const [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(input.path, { bigint: true }),
    ]);
    if (
      !handleStat.isFile() ||
      !pathStat.isFile() ||
      handleStat.size > BigInt(input.maxBytes) ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino
    ) {
      throw input.invalidFile();
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export interface PublishMarkerFileInput {
  root: string;
  markerFile: string;
  contents: string;
  maxBytes: number;
  publication: 'create' | 'replace';
  beforePublish?(): Promise<void>;
  invalidFile(): Error;
}

export async function publishMarkerFile(
  input: PublishMarkerFileInput,
  dependencies: Partial<MarkerFileDependencies> = {},
): Promise<'published' | 'already_exists'> {
  const deps = { ...defaultDependencies, ...dependencies };
  if (Buffer.byteLength(input.contents, 'utf8') > input.maxBytes) {
    throw input.invalidFile();
  }

  const markerPath = join(input.root, input.markerFile);
  const tempPath = join(input.root, `${input.markerFile}.${process.pid}.${deps.randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const handle = await deps.open(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(input.contents, 'utf8');
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }

    await input.beforePublish?.();
    if (input.publication === 'create') {
      try {
        await link(tempPath, markerPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        return 'already_exists';
      }
    } else {
      await rename(tempPath, markerPath);
      tempCreated = false;
    }
    await syncDirectory(input.root, deps);
    return 'published';
  } finally {
    if (tempCreated) await unlinkIfPresent(tempPath);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function syncDirectory(path: string, deps: MarkerFileDependencies): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await deps.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function markerReadFlags(): string | number {
  if (process.platform === 'win32') return 'r';
  return fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
