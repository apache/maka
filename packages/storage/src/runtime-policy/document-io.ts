import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncDirectory } from '../stable-storage.js';
import {
  commitOutcomeUnknown,
  invalidDocument,
  ioFailed,
  RuntimePolicyStoreError,
} from './errors.js';

export const POLICY_DOCUMENT_MAX_BYTES = 48 * 1024;
export const CATALOG_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export const VAULT_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;
const RUNTIME_POLICY_TEMP_PATTERN =
  /^(?:runtime-policy|connection-catalog|credential-vault)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

export async function cleanupRuntimePolicyDocumentTemps(root: string): Promise<void> {
  let failure: unknown;
  try {
    const entries = await readdir(root);
    for (const entry of entries) {
      if (!RUNTIME_POLICY_TEMP_PATTERN.test(entry)) continue;
      const path = join(root, entry);
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw ioFailed('A runtime policy temporary artifact could not be inspected', error);
      }
      if (metadata.isDirectory()) {
        throw invalidDocument('Runtime policy temporary artifacts must not be directories');
      }
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw ioFailed('A runtime policy temporary artifact could not be removed', error);
      }
    }
  } catch (error) {
    failure =
      error instanceof RuntimePolicyStoreError
        ? error
        : ioFailed('Runtime policy temporary artifacts could not be listed', error);
  }

  try {
    await syncDirectory(root);
  } catch (error) {
    failure ??= ioFailed(
      'Runtime policy temporary artifact cleanup could not be synchronized',
      error,
    );
  }
  if (failure !== undefined) throw failure;
}

export async function readBoundedJsonDocument(
  root: string,
  file: string,
  maxBytes: number,
): Promise<unknown | undefined> {
  const path = join(root, file);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (process.platform !== 'win32' && (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw invalidDocument(`${file} must not be a symbolic link`, error);
    }
    throw ioFailed(`${file} could not be opened`, error);
  }

  let result: unknown | undefined;
  let failure: unknown;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw invalidDocument(`${file} must be a regular file`);
    if (metadata.size > maxBytes)
      throw invalidDocument(`${file} exceeds its ${maxBytes} byte limit`);

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) throw invalidDocument(`${file} exceeds its ${maxBytes} byte limit`);
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total > maxBytes) throw invalidDocument(`${file} exceeds its ${maxBytes} byte limit`);

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch (error) {
      throw invalidDocument(`${file} is not valid UTF-8`, error);
    }
    try {
      result = JSON.parse(text) as unknown;
    } catch (error) {
      throw invalidDocument(`${file} is not valid JSON`, error);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    if (failure instanceof RuntimePolicyStoreError) throw failure;
    throw ioFailed(`${file} could not be read`, failure);
  }
  return result;
}

export async function writeJsonDocument(
  root: string,
  file: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  const bytes = serializeJsonDocument(value);
  if (bytes.length > maxBytes) throw invalidDocument(`${file} exceeds its ${maxBytes} byte limit`);

  const path = join(root, file);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  let published = false;
  let failure: unknown;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(root);
  } catch (error) {
    failure = error;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (temporaryCreated && !published) {
      try {
        await rm(temporaryPath, { force: true });
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure === undefined) return;
  if (published) {
    throw commitOutcomeUnknown(
      `${file} commit outcome is unknown; reload before retrying`,
      failure,
    );
  }
  throw ioFailed(`${file} I/O failed before publication`, failure);
}

export function serializeJsonDocument(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
