import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  assertExecutionBoundaryCapacity,
  decodeExecutionBoundary,
  MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES,
  type ExecutionBoundary,
} from '@maka/core';
import { decodeSessionHeader, isSafeSessionId } from './session-store.js';
import {
  createSessionTranscriptMarker,
  decodeSessionTranscriptMarker,
  isSessionTranscriptMarker,
} from './session-transcript.js';
import type {
  SessionMetadataImportEntry,
  SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';

const LEGACY_SESSION_HEADER_MAX_BYTES = 1024 * 1024;
const LEGACY_SESSION_HEADER_READ_BYTES = 8192;
// A transfer contains the cumulative session boundary, not one 64 KiB expansion request.
export const EXECUTION_BOUNDARY_TRANSFER_MAX_BYTES = MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES + 64;
export const EXECUTION_BOUNDARY_TRANSFER_FILE = 'execution-boundary.json';

export function encodeExecutionBoundaryTransfer(boundary: ExecutionBoundary): string {
  assertExecutionBoundaryCapacity(boundary);
  const raw = `${JSON.stringify({ schemaVersion: 1, boundary })}\n`;
  if (Buffer.byteLength(raw, 'utf8') > EXECUTION_BOUNDARY_TRANSFER_MAX_BYTES) {
    throw new Error('Execution boundary transfer exceeds the serialized size limit');
  }
  return raw;
}

class MalformedLegacySessionHeaderError extends Error {
  constructor(sourcePath: string, cause?: unknown) {
    super(`Invalid legacy session header at ${sourcePath}`, { cause });
    this.name = 'MalformedLegacySessionHeaderError';
  }
}

export interface LegacySessionMetadataImportReport {
  filesScanned: number;
  headersRead: number;
  headersImported: number;
  headersExisting: number;
  sourcesAlreadyImported: number;
  sourcesTombstoned: number;
}

export interface LegacySessionMetadataEntry extends SessionMetadataImportEntry {
  boundaryTransferPath?: string;
}

/**
 * Import every legacy line-1 SessionHeader in one SQLite transaction.
 *
 * The scan and decode phase completes before the transaction begins.
 * Malformed headers are skipped (not tombstoned) so one corrupt session
 * cannot block the rest of the catalog.  Skipping without tombstoning means
 * a repaired header will be picked up on the next launch.
 */
export async function importLegacySessionMetadataTree(input: {
  workspaceRoot: string;
  destination: SqliteSessionMetadataStore;
}): Promise<LegacySessionMetadataImportReport> {
  const sessionsRoot = join(input.workspaceRoot, 'sessions');
  const entries: LegacySessionMetadataEntry[] = [];
  const transcriptMarkerSessionIds: string[] = [];
  const directories = await sessionDirectoryNames(sessionsRoot);
  for (const directory of directories) {
    const sourcePath = join(sessionsRoot, directory, 'session.jsonl');
    try {
      const entry = await readLegacySessionMetadataEntry(sourcePath, directory);
      if (entry) {
        entries.push(entry);
      } else {
        transcriptMarkerSessionIds.push(directory);
      }
    } catch (error) {
      if (isNotFound(error)) {
        const canonicalStateExists =
          (await input.destination.has(directory)) ||
          (await input.destination.isTombstoned(directory));
        if (canonicalStateExists) continue;
        throw error;
      }
      // Corrupt or malformed legacy session headers should not crash the
      // entire import. Skip the session without tombstoning it — the
      // deletion tombstone is permanent and would suppress a repaired
      // header on subsequent launches. Skipping means the malformed
      // session is retried next launch, which is harmless (it will be
      // skipped again until repaired).
      if (error instanceof MalformedLegacySessionHeaderError) {
        continue;
      }
      throw error;
    }
  }
  for (const sessionId of transcriptMarkerSessionIds) {
    if (
      !(await input.destination.has(sessionId)) &&
      !(await input.destination.isTombstoned(sessionId))
    ) {
      if (await removeRecoverableOrphanTranscriptMarker(sessionsRoot, sessionId)) continue;
      throw new Error(`Session transcript marker has no SQLite metadata: ${sessionId}`);
    }
  }
  const result = await input.destination.importEntries(entries);
  await Promise.all(
    entries.map((entry) =>
      entry.boundaryTransferPath
        ? rm(entry.boundaryTransferPath, { force: true })
        : Promise.resolve(),
    ),
  );
  const headersImported = result.created.filter(Boolean).length;
  return {
    filesScanned: directories.length,
    headersRead: entries.length,
    headersImported,
    headersExisting: result.created.length - headersImported,
    sourcesAlreadyImported: result.sourcesAlreadyImported,
    sourcesTombstoned: result.sourcesTombstoned,
  };
}

/**
 * Recover only the exact filesystem state published before SQLite admission:
 * one canonical marker record in an otherwise empty Session directory.
 *
 * Any extra transcript byte or directory entry may contain user/runtime state
 * and therefore remains a fail-closed corruption boundary.
 */
async function removeRecoverableOrphanTranscriptMarker(
  sessionsRoot: string,
  sessionId: string,
): Promise<boolean> {
  const sessionDir = join(sessionsRoot, sessionId);
  const entries = await readdir(sessionDir, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== 'session.jsonl' || !entries[0].isFile()) {
    return false;
  }
  const path = join(sessionDir, 'session.jsonl');
  const actual = await readFile(path, 'utf8');
  const expected = `${JSON.stringify(createSessionTranscriptMarker(sessionId))}\n`;
  if (actual !== expected) return false;
  await rm(sessionDir, { recursive: true });
  return true;
}

export async function readLegacySessionMetadataEntry(
  sourcePath: string,
  sessionId: string,
): Promise<LegacySessionMetadataEntry | null> {
  const headerLine = await readFirstJsonlRecord(sourcePath);
  let value: unknown;
  try {
    value = JSON.parse(headerLine) as unknown;
  } catch (error) {
    throw new MalformedLegacySessionHeaderError(sourcePath, error);
  }
  if (isSessionTranscriptMarker(value)) {
    decodeSessionTranscriptMarker(value, sessionId);
    return null;
  }
  let header;
  try {
    header = decodeSessionHeader(value, sessionId);
  } catch (error) {
    throw new MalformedLegacySessionHeaderError(sourcePath, error);
  }
  const boundaryTransfer = await readExecutionBoundaryTransfer(sourcePath);
  const fingerprintSource = boundaryTransfer
    ? `${headerLine}\n${boundaryTransfer.raw}`
    : headerLine;
  return {
    header,
    ...(boundaryTransfer
      ? {
          initialBoundary: boundaryTransfer.boundary,
          boundaryTransferPath: boundaryTransfer.path,
        }
      : {}),
    source: {
      path: sourcePath,
      fingerprint: createHash('sha256').update(fingerprintSource).digest('hex'),
    },
  };
}

async function readExecutionBoundaryTransfer(sourcePath: string): Promise<
  | {
      boundary: ExecutionBoundary;
      path: string;
      raw: string;
    }
  | undefined
> {
  const path = join(dirname(sourcePath), EXECUTION_BOUNDARY_TRANSFER_FILE);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!info.isFile() || info.size > EXECUTION_BOUNDARY_TRANSFER_MAX_BYTES) {
    throw new MalformedLegacySessionHeaderError(
      sourcePath,
      new Error(`Invalid execution boundary transfer at ${path}`),
    );
  }
  const raw = await readFile(path, 'utf8');
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== 1 ||
      !('boundary' in value)
    ) {
      throw new Error('Invalid execution boundary transfer envelope');
    }
    return {
      boundary: decodeExecutionBoundary(value.boundary),
      path,
      raw,
    };
  } catch (error) {
    throw new MalformedLegacySessionHeaderError(sourcePath, error);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function sessionDirectoryNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isSafeSessionId(entry.name)) {
      throw new Error(`Invalid Session entry: ${entry.name}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function readFirstJsonlRecord(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < LEGACY_SESSION_HEADER_MAX_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(LEGACY_SESSION_HEADER_READ_BYTES, LEGACY_SESSION_HEADER_MAX_BYTES - offset),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline >= 0) return text.slice(0, newline);
      offset += bytesRead;
    }
    throw new MalformedLegacySessionHeaderError(
      path,
      new Error(`Cannot read legacy session header from ${path}`),
    );
  } finally {
    await handle.close();
  }
}
