import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import {
  createToolResultArchiveCapability,
  type ToolResultArchiveCapability,
  type ToolResultArchiveRecorderInput,
} from '@maka/runtime/tool-result-archive-capability';
import { isPathInside } from '@maka/runtime/path-containment';
import { stableToolResultArchiveArtifactId } from '@maka/runtime/tool-result-archive';
import { type ToolArtifactRecorderInput } from '@maka/runtime/tool-artifacts';
import {
  type ToolResultArchiveReaderInput,
  type ToolResultArchiveReadResult,
} from '@maka/runtime/context-budget';
import { type ToolResultArchiveResourceReadInput } from '@maka/runtime/tool-result-archive-resource';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';

export interface HostExecutionArtifactServices {
  recordToolArtifacts(event: ToolArtifactRecorderInput): Promise<void>;
  /**
   * One archive authority over the session artifact store (#2026). All three
   * reads and the writer address the same store, so the host has no way to hand
   * out half of it.
   */
  toolResultArchive: ToolResultArchiveCapability;
}

export function createHostExecutionArtifactServices(input: {
  artifacts: InteractiveArtifactStoreWriter;
  requestDrain: () => void;
}): HostExecutionArtifactServices {
  const runWrite = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      input.requestDrain();
      throw error;
    }
  };

  const recordToolArtifacts = async (event: ToolArtifactRecorderInput): Promise<void> => {
    for (const candidate of event.candidates) {
      let content = candidate.content;
      if (content === undefined && candidate.sourcePath) {
        content = (await readBoundedSourceFile(event.cwd, candidate.sourcePath)) ?? undefined;
      }
      if (content === undefined || contentBytes(content) > MAX_ATTACHMENT_BYTES) continue;
      await runWrite(() =>
        input.artifacts.create({
          sessionId: event.sessionId,
          turnId: event.turnId,
          name: candidate.name,
          kind: candidate.kind,
          content,
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          source: candidate.source ?? 'tool_result',
          ...(candidate.summary ? { summary: candidate.summary } : {}),
        }),
      );
    }
  };

  const services: HostExecutionArtifactServices = {
    recordToolArtifacts,
    toolResultArchive: createToolResultArchiveCapability({
      archiveToolResult: (event: ToolResultArchiveRecorderInput) =>
        runWrite(async () => {
          const artifactId = stableToolResultArchiveArtifactId(event);
          const existing = await input.artifacts.getInSession(event.sessionId, artifactId);
          if (existing.record?.status === 'live') {
            const read = await readArchive(input.artifacts, {
              artifactId,
              sessionId: event.sessionId,
              bodySha256: event.bodySha256,
              originalBytes: event.originalBytes,
              maxBytes: event.originalBytes,
            });
            if (!read.ok) {
              throw new Error(`Tool result archive identity conflict: ${read.reason}`);
            }
            return { artifactId };
          }
          const artifact = await input.artifacts.create({
            id: artifactId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            name: `archived-${event.toolName}-${event.runtimeEventId}.json`,
            kind: 'file',
            content: event.serializedResult,
            mimeType: 'application/json',
            source: 'tool_result_archive',
            summary: `Archived ${event.toolName} tool result for context budget replay`,
          });
          return { artifactId: artifact.id };
        }),
      readToolResultArchive: (event: ToolResultArchiveReaderInput) =>
        readArchive(input.artifacts, event),
      readArchivedToolResultResource: (event: ToolResultArchiveResourceReadInput) =>
        readArchive(input.artifacts, event),
    }),
  };
  return Object.freeze(services);
}

async function readBoundedSourceFile(cwd: string, sourcePath: string): Promise<Buffer | null> {
  const candidate = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
  let root: string;
  let target: string;
  try {
    [root, target] = await Promise.all([realpath(cwd), realpath(candidate)]);
  } catch {
    return null;
  }
  if (!isPathInside(root, target)) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_ATTACHMENT_BYTES) return null;
    const currentTarget = await realpath(target);
    if (!isPathInside(root, currentTarget)) return null;
    const current = await stat(currentTarget);
    if (current.dev !== opened.dev || current.ino !== opened.ino) return null;
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    return offset === bytes.byteLength ? bytes : bytes.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function contentBytes(content: string | Uint8Array): number {
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
}

async function readArchive(
  artifacts: InteractiveArtifactStoreWriter,
  event: Pick<
    ToolResultArchiveReaderInput,
    'artifactId' | 'sessionId' | 'bodySha256' | 'originalBytes' | 'maxBytes'
  >,
): Promise<ToolResultArchiveReadResult> {
  const entry = await artifacts.getInSession(event.sessionId, event.artifactId);
  const record = entry.record;
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
  if (record.source !== 'tool_result_archive') return { ok: false, reason: 'source_mismatch' };
  if (record.sizeBytes !== event.originalBytes) return { ok: false, reason: 'size_mismatch' };
  const read = await artifacts.readTextInSession(event.sessionId, event.artifactId, {
    maxBytes: event.maxBytes ?? event.originalBytes,
  });
  if (!read.ok) return read;
  if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
  return { ok: true, serializedResult: read.text };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
