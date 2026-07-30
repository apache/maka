import { open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export async function syncFile(path: string): Promise<void> {
  // Windows rejects fsync on a read-only handle (EPERM). Durable store files
  // are writer-owned, so reopen the existing file read/write without creating
  // or truncating it before re-establishing the stable-storage barrier.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryChain(path: string, root: string): Promise<void> {
  const boundary = resolve(root);
  let current = resolve(path);
  const pathFromBoundary = relative(boundary, current);
  if (
    pathFromBoundary === '..' ||
    pathFromBoundary.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBoundary)
  ) {
    throw new Error(`Durability path escapes workspace root: ${path}`);
  }
  while (true) {
    await syncDirectory(current);
    if (current === boundary) return;
    current = dirname(current);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
