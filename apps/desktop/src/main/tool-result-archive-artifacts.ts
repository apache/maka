import { createHash } from 'node:crypto';
import type { ArtifactStore } from '@maka/storage';
import {
  stableToolResultArchiveArtifactId,
  type ToolResultArchiveReaderInput,
  type ToolResultArchiveReadResult,
  type ToolResultArchiveRecorderInput,
  type ToolResultArchiveResourceReadInput,
} from '@maka/runtime';

export async function persistArchivedToolResultToArtifacts(
  artifactStore: Pick<ArtifactStore, 'create' | 'get' | 'readText'>,
  event: ToolResultArchiveRecorderInput,
): Promise<{ artifactId: string; created: boolean }> {
  const id = stableToolResultArchiveArtifactId(event);
  const existing = await artifactStore.get(id);
  if (existing?.status === 'live') {
    const read = await readArchivedToolResultArtifact(artifactStore, {
      artifactId: id,
      sessionId: event.sessionId,
      bodySha256: event.bodySha256,
      originalBytes: event.originalBytes,
      maxBytes: event.originalBytes,
    });
    if (!read.ok) throw new Error(`tool result archive artifact id conflict: ${read.reason}`);
    return { artifactId: id, created: false };
  }

  const artifact = await artifactStore.create({
    id,
    sessionId: event.sessionId,
    turnId: event.turnId,
    name: `archived-${event.toolName}-${event.runtimeEventId}.json`,
    kind: 'file',
    content: event.serializedResult,
    mimeType: 'application/json',
    source: 'tool_result_archive',
    summary: `Archived ${event.toolName} tool result for context budget replay`,
  });
  return { artifactId: artifact.id, created: true };
}

export async function readArchivedToolResultFromArtifacts(
  artifactStore: Pick<ArtifactStore, 'get' | 'readText'>,
  event: ToolResultArchiveReaderInput,
): Promise<ToolResultArchiveReadResult> {
  return readArchivedToolResultArtifact(artifactStore, event);
}

export async function readArchivedToolResultResourceFromArtifacts(
  artifactStore: Pick<ArtifactStore, 'get' | 'readText'>,
  event: ToolResultArchiveResourceReadInput,
): Promise<ToolResultArchiveReadResult> {
  return readArchivedToolResultArtifact(artifactStore, event);
}

async function readArchivedToolResultArtifact(
  artifactStore: Pick<ArtifactStore, 'get' | 'readText'>,
  event: Pick<ToolResultArchiveReaderInput, 'artifactId' | 'sessionId' | 'bodySha256' | 'originalBytes' | 'maxBytes'>,
): Promise<ToolResultArchiveReadResult> {
  const record = await artifactStore.get(event.artifactId);
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
  if (record.source !== 'tool_result_archive') return { ok: false, reason: 'source_mismatch' };
  if (record.sessionId !== event.sessionId) return { ok: false, reason: 'session_mismatch' };
  if (record.sizeBytes !== event.originalBytes) return { ok: false, reason: 'size_mismatch' };

  const read = await artifactStore.readText(event.artifactId, {
    maxBytes: event.maxBytes ?? event.originalBytes,
  });
  if (!read.ok) return read;
  if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
  return { ok: true, serializedResult: read.text };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
