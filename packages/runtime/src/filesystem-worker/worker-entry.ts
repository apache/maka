import { stdin, stdout } from 'node:process';

import { executeFilesystemWorkerRequest } from './operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerRequestSchema,
  FilesystemWorkerResponseSchema,
  type FilesystemWorkerResponse,
} from './protocol.js';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readBoundedStdin();
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      writeResponse(
        invalidRequestResponse(
          'invalid-request',
          'Filesystem worker request exceeded the size limit.',
        ),
      );
      return;
    }
    throw error;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    writeResponse(
      invalidRequestResponse('invalid-request', 'Filesystem worker request was not valid JSON.'),
    );
    return;
  }
  const parsed = FilesystemWorkerRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    writeResponse(
      invalidRequestResponse(
        requestIdFromUnknown(decoded),
        'Filesystem worker request was invalid.',
      ),
    );
    return;
  }
  writeResponse(
    await executeFilesystemWorkerRequest(parsed.data, {
      grepExecutable: readOption('--grep-executable'),
      windowsSandboxed: process.env.MAKA_WINDOWS_SANDBOX === '1',
    }),
  );
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class RequestTooLargeError extends Error {}

function writeResponse(response: FilesystemWorkerResponse): void {
  stdout.write(`${JSON.stringify(FilesystemWorkerResponseSchema.parse(response))}\n`);
}

function invalidRequestResponse(requestId: string, message: string): FilesystemWorkerResponse {
  return {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code: 'invalid_request', message },
  };
}

function requestIdFromUnknown(input: unknown): string {
  if (!input || typeof input !== 'object' || !('requestId' in input)) return 'invalid-request';
  const requestId = input.requestId;
  return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 256
    ? requestId
    : 'invalid-request';
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value || undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `filesystem worker bootstrap failed: ${error instanceof Error ? error.name : 'unknown'}\n`,
  );
  process.exitCode = 1;
});
