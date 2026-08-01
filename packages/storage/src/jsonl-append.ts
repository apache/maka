import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DurableStoreWriteError } from '@maka/core';
import { classifyJsonRecord } from './json-prefix.js';
import { syncDirectoryChain } from './stable-storage.js';

const REVERSE_SCAN_CHUNK_BYTES = 64 * 1024;

class JsonlAppendPreconditionError extends Error {
  readonly name = 'JsonlAppendPreconditionError';
}

export interface AppendJsonlOptions {
  durable?: boolean;
  durabilityRoot?: string;
  requireExistingRecord?: boolean;
}

export async function appendJsonl(
  path: string,
  payload: string,
  options: AppendJsonlOptions = {},
): Promise<void> {
  try {
    await appendJsonlUnchecked(path, payload, options);
  } catch (error) {
    if (
      !options.durable ||
      error instanceof DurableStoreWriteError ||
      error instanceof JsonlAppendPreconditionError
    ) {
      throw error;
    }
    throw new DurableStoreWriteError(
      `Durable JSONL append did not reach stable storage: ${path}`,
      error,
    );
  }
}

async function appendJsonlUnchecked(
  path: string,
  payload: string,
  options: AppendJsonlOptions,
): Promise<void> {
  if (payload.length === 0 || !payload.endsWith('\n')) {
    throw new JsonlAppendPreconditionError('JSONL append payload must end with a newline');
  }

  const flags =
    constants.O_RDWR | constants.O_APPEND | (options.requireExistingRecord ? 0 : constants.O_CREAT);
  const handle = await open(path, flags, 0o600);
  try {
    const size = (await handle.stat()).size;
    if (size === 0 && options.requireExistingRecord) {
      throw new JsonlAppendPreconditionError('Cannot append to an empty JSONL document');
    }

    let separator = '';
    if (size > 0 && !(await endsWithNewline(handle, size))) {
      const tailStart = await findTrailingRecordStart(handle, size);
      const tail = await readRange(handle, tailStart, size);
      const classification = classifyJsonRecord(tail);
      if (classification === 'complete') {
        separator = '\n';
      } else if (classification === 'incomplete-prefix') {
        if (tailStart === 0 && options.requireExistingRecord) {
          throw new JsonlAppendPreconditionError('Cannot repair a truncated JSONL document header');
        }
        await handle.truncate(tailStart);
        await handle.sync();
      } else {
        throw new JsonlAppendPreconditionError('Cannot append after an invalid JSONL tail record');
      }
    }

    await handle.appendFile(separator + payload, 'utf8');
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.durable) {
    if (!options.durabilityRoot) {
      throw new Error('Durable JSONL append requires a durability root');
    }
    await syncDirectoryChain(dirname(path), options.durabilityRoot);
  }
}

async function endsWithNewline(handle: FileHandle, size: number): Promise<boolean> {
  const byte = Buffer.allocUnsafe(1);
  await readFully(handle, byte, size - 1);
  return byte[0] === 0x0a;
}

async function findTrailingRecordStart(handle: FileHandle, size: number): Promise<number> {
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - REVERSE_SCAN_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(end - start);
    await readFully(handle, chunk, start);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    end = start;
  }
  return 0;
}

async function readRange(handle: FileHandle, start: number, end: number): Promise<string> {
  const bytes = Buffer.allocUnsafe(end - start);
  await readFully(handle, bytes, start);
  return bytes.toString('utf8');
}

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error('Unexpected end of JSONL document');
    offset += bytesRead;
  }
}
