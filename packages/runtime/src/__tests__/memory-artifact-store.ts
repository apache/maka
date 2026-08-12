import { Buffer } from 'node:buffer';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { HistoryCompactArtifactStore } from '../history-compact-artifacts.js';

// Shared in-memory HistoryCompactArtifactStore for tests. Not a test file
// itself (no .test. suffix), so the runner glob skips it.
export function memoryArtifactStore(): HistoryCompactArtifactStore {
  const records = new Map<string, { record: ArtifactRecord; content: string }>();
  return {
    async create(input) {
      const id = input.id ?? `artifact-${records.size + 1}`;
      const record: ArtifactRecord = {
        id,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: input.now ?? 0,
        name: input.name,
        kind: input.kind,
        relativePath: input.name,
        sizeBytes: Buffer.byteLength(input.content, 'utf8'),
        mimeType: input.mimeType,
        source: input.source,
        summary: input.summary,
        status: 'live',
      };
      records.set(id, { record, content: input.content });
      return record;
    },
    async delete(artifactId) {
      const entry = records.get(artifactId);
      if (entry) entry.record.status = 'deleted';
    },
    async purge(artifactIds) {
      for (const artifactId of artifactIds) records.delete(artifactId);
    },
    async list() {
      return [...records.values()].map((entry) => entry.record);
    },
    async readText(artifactId) {
      const entry = records.get(artifactId);
      if (!entry) return { ok: false, reason: 'not_found' };
      return { ok: true, text: entry.content };
    },
  };
}
