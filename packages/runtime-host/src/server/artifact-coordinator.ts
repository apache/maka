import { createHash } from 'node:crypto';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  authenticateInteractiveArtifactStoreWriter,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
  type ArtifactProjection,
  type ArtifactQueryInput,
  type ArtifactQueryResult,
  type ArtifactRevision,
  type OperationOutcome,
} from '../protocol/index.js';
import type { ArtifactOperationHandlerMap } from './operation-dispatcher.js';

/** Session-scoped Host projection and deletion authority for Artifacts. */
export class HostArtifactCoordinator {
  readonly handlers: ArtifactOperationHandlerMap = {
    'artifact.query': (input) => this.#query(input),
    'artifact.delete': (input) => this.#delete(input),
  };

  readonly #store: InteractiveArtifactStoreWriter;

  constructor(store: InteractiveArtifactStoreWriter) {
    this.#store = authenticateInteractiveArtifactStoreWriter(store);
  }

  async #query(input: ArtifactQueryInput): Promise<OperationOutcome<'artifact.query'>> {
    try {
      if (input.kind === 'read_text' || input.kind === 'read_binary') {
        const record = await this.#store.get(input.artifactId);
        if (!record || record.sessionId !== input.sessionId) {
          return querySuccess(readUnavailable(input, 'not_found'));
        }
        if (input.kind === 'read_text') {
          const preview = await this.#store.readText(input.artifactId, {
            maxBytes: ARTIFACT_PREVIEW_MAX_BYTES,
          });
          return querySuccess(
            encodeTextResult({
              kind: 'text',
              sessionId: input.sessionId,
              artifactId: input.artifactId,
              preview,
            }),
          );
        }
        const preview = await this.#store.readBinary(input.artifactId, {
          maxBytes: ARTIFACT_PREVIEW_MAX_BYTES,
        });
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'binary',
            sessionId: input.sessionId,
            artifactId: input.artifactId,
            preview,
          }),
        );
      }

      const records = await this.#store.list(input.sessionId, { includeDeleted: true });
      const artifacts = records.map(projectArtifact);
      const revision = artifactRevision(artifacts);
      if (input.kind === 'get') {
        const artifact = artifacts.find((candidate) => candidate.id === input.artifactId) ?? null;
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'artifact',
            sessionId: input.sessionId,
            revision,
            artifact,
          }),
        );
      }
      if (input.kind === 'list_continue' && input.revision !== revision) {
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'revision_changed',
            expected: input.revision,
            actual: revision,
          }),
        );
      }
      const offset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > artifacts.length ||
        (input.kind === 'list_continue' && offset === artifacts.length)
      ) {
        return invalidQuery('Artifact cursor is invalid');
      }
      return querySuccess(createPage(input.sessionId, revision, artifacts, offset));
    } catch {
      return persistenceFailure('artifact.query', 'Artifact projection is unavailable');
    }
  }

  async #delete(input: {
    readonly sessionId: string;
    readonly artifactId: string;
  }): Promise<OperationOutcome<'artifact.delete'>> {
    try {
      const existing = await this.#store.get(input.artifactId);
      if (!existing || existing.sessionId !== input.sessionId) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Artifact was not found' },
        };
      }
      if (isProtectedRuntimeEvidence(existing)) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Protected runtime evidence cannot be deleted through Runtime Host',
          },
        };
      }
      await this.#store.delete(input.artifactId);
      const canonical = await this.#store.get(input.artifactId);
      if (!canonical || canonical.sessionId !== input.sessionId || canonical.status !== 'deleted') {
        throw new Error('Artifact deletion did not publish a canonical tombstone');
      }
      return {
        ok: true,
        result: encodeArtifactDeleteResult({
          kind: 'deleted',
          artifact: projectArtifact(canonical),
        }),
      };
    } catch {
      return persistenceFailure('artifact.delete', 'Artifact deletion could not be committed');
    }
  }
}

function isProtectedRuntimeEvidence(record: Pick<ArtifactRecord, 'source'>): boolean {
  return record.source === 'deep_research' || record.source === 'tool_result_archive';
}

function projectArtifact(record: ArtifactRecord): ArtifactProjection {
  return {
    id: record.id,
    sessionId: record.sessionId,
    turnId: record.turnId,
    createdAt: record.createdAt,
    name: projectText(record.name, ARTIFACT_NAME_MAX_BYTES),
    kind: record.kind,
    sizeBytes: record.sizeBytes,
    ...(record.mimeType === undefined
      ? {}
      : { mimeType: projectText(record.mimeType, ARTIFACT_MIME_TYPE_MAX_BYTES) }),
    ...(record.source === undefined ? {} : { source: record.source }),
    ...(record.summary === undefined
      ? {}
      : { summary: projectText(record.summary, ARTIFACT_SUMMARY_MAX_BYTES) }),
    status: record.status,
  };
}

function artifactRevision(artifacts: readonly ArtifactProjection[]): ArtifactRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(artifacts)).digest('hex')}`;
}

function projectText(value: string, maxBytes: number): string {
  let bytes = 0;
  let projected = '';
  for (const codePoint of value) {
    const scalar = codePoint.codePointAt(0)!;
    const canonical = scalar <= 0x1f || scalar === 0x7f ? '\ufffd' : codePoint;
    const width = Buffer.byteLength(canonical, 'utf8');
    if (bytes + width > maxBytes) break;
    projected += canonical;
    bytes += width;
  }
  return projected || 'artifact';
}

function createPage(
  sessionId: string,
  revision: ArtifactRevision,
  artifacts: readonly ArtifactProjection[],
  offset: number,
): ArtifactQueryResult {
  const pageArtifacts: ArtifactProjection[] = [];
  for (let index = offset; index < artifacts.length; index += 1) {
    if (pageArtifacts.length >= ARTIFACT_PAGE_MAX_ITEMS) break;
    const artifact = artifacts[index];
    if (!artifact) break;
    const candidateArtifacts = [...pageArtifacts, artifact];
    const nextOffset = index + 1;
    const candidate: ArtifactQueryResult = {
      kind: 'page',
      sessionId,
      revision,
      artifacts: candidateArtifacts,
      nextCursor: nextOffset < artifacts.length ? String(nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > ARTIFACT_RESULT_MAX_BYTES) {
      if (pageArtifacts.length === 0) {
        throw new Error('A canonical Artifact cannot fit in one page');
      }
      break;
    }
    pageArtifacts.push(artifact);
  }
  const nextOffset = offset + pageArtifacts.length;
  return encodeArtifactQueryResult({
    kind: 'page',
    sessionId,
    revision,
    artifacts: pageArtifacts,
    nextCursor: nextOffset < artifacts.length ? String(nextOffset) : null,
  });
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function readUnavailable(
  input: Extract<ArtifactQueryInput, { kind: 'read_text' | 'read_binary' }>,
  reason: 'not_found',
): ArtifactQueryResult {
  if (input.kind === 'read_text') {
    return {
      kind: 'text',
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      preview: { ok: false, reason },
    };
  }
  return {
    kind: 'binary',
    sessionId: input.sessionId,
    artifactId: input.artifactId,
    preview: { ok: false, reason },
  };
}

function encodeTextResult(
  result: Extract<ArtifactQueryResult, { kind: 'text' }>,
): ArtifactQueryResult {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= ARTIFACT_RESULT_MAX_BYTES) {
    return encodeArtifactQueryResult(result);
  }
  return encodeArtifactQueryResult({
    ...result,
    preview: { ok: false, reason: 'too_large' },
  });
}

function querySuccess(result: ArtifactQueryResult): OperationOutcome<'artifact.query'> {
  return { ok: true, result };
}

function invalidQuery(message: string): OperationOutcome<'artifact.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function persistenceFailure<K extends 'artifact.query' | 'artifact.delete'>(
  _operation: K,
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code: 'persistence_failed', message } } as OperationOutcome<K>;
}
