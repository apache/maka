import type { Readable } from 'node:stream';
import { open } from 'node:fs/promises';

export interface BoundedCapture {
  readonly observedBytes: number;
  readonly truncatedBytes: number;
}

const MARKER_RESERVE_BYTES = 128;

export async function captureBoundedStream(
  input: Readable,
  path: string,
  limitBytes: number,
  tailBytes: number,
): Promise<BoundedCapture> {
  if (limitBytes <= MARKER_RESERVE_BYTES || tailBytes < 1 || tailBytes >= limitBytes) {
    throw new Error('bounded log limits are invalid');
  }
  const prefixLimit = limitBytes - tailBytes - MARKER_RESERVE_BYTES;
  const output = await open(path, 'w', 0o600);
  let observedBytes = 0;
  let prefixBytes = 0;
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    for await (const chunk of input) {
      let remaining = Buffer.from(chunk);
      observedBytes += remaining.length;
      if (prefixBytes < prefixLimit) {
        const length = Math.min(prefixLimit - prefixBytes, remaining.length);
        await output.write(remaining.subarray(0, length));
        prefixBytes += length;
        remaining = remaining.subarray(length);
      }
      if (remaining.length > 0) tail = appendTail(tail, remaining, tailBytes);
    }
    if (observedBytes <= limitBytes) {
      if (tail.length > 0) await output.write(tail);
      return { observedBytes, truncatedBytes: 0 };
    }
    const truncatedBytes = Math.max(0, observedBytes - prefixBytes - tail.length);
    const marker = Buffer.from(`\n{"makaEvalTruncatedBytes":${truncatedBytes}}\n`);
    await output.write(marker.subarray(0, MARKER_RESERVE_BYTES));
    await output.write(tail);
    return { observedBytes, truncatedBytes };
  } finally {
    await output.close();
  }
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  limit: number,
): Buffer<ArrayBufferLike> {
  if (chunk.length >= limit) return chunk.subarray(chunk.length - limit);
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= limit ? combined : combined.subarray(combined.length - limit);
}
