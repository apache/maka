import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  authenticateInteractiveArtifactStoreWriter,
  type InteractiveArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
  type ArtifactProjection,
  type ArtifactQueryInput,
  type ArtifactQueryResult,
  type ArtifactRevision,
  type OperationOutcome,
} from '../protocol/index.js';
import { encodeArtifactProjection } from '../protocol/artifact.js';
import type { ArtifactOperationHandlerMap } from './operation-dispatcher.js';

/** Session-scoped Host projection and deletion authority for Artifacts. */
export class HostArtifactCoordinator {
  readonly handlers: ArtifactOperationHandlerMap = {
    'artifact.query': (input) => this.#query(input),
    'artifact.delete': (input) => this.#delete(input),
  };

  readonly #store: InteractiveArtifactStoreWriter;
  readonly #requestDrain: () => void;

  constructor(store: InteractiveArtifactStoreWriter, requestDrain: () => void) {
    this.#store = authenticateInteractiveArtifactStoreWriter(store);
    this.#requestDrain = requestDrain;
  }

  async #query(input: ArtifactQueryInput): Promise<OperationOutcome<'artifact.query'>> {
    try {
      if (input.kind === 'read_text' || input.kind === 'read_binary') {
        if (input.kind === 'read_text') {
          const preview = await this.#store.readTextInSession(input.sessionId, input.artifactId, {
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
        const preview = await this.#store.readBinaryInSession(input.sessionId, input.artifactId, {
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

      if (input.kind === 'get') {
        const entry = await this.#store.getInSession(input.sessionId, input.artifactId);
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'artifact',
            sessionId: input.sessionId,
            revision: entry.revision,
            artifact: entry.record ? encodeArtifactProjection(entry.record) : null,
          }),
        );
      }

      const decodedOffset = input.kind === 'list_start' ? 0 : decodeCursor(input.cursor);
      const offset = decodedOffset ?? 0;
      const page = await this.#store.listPage(input.sessionId, {
        offset,
        limit: ARTIFACT_PAGE_MAX_ITEMS,
      });
      if (input.kind === 'list_continue' && input.revision !== page.revision) {
        return querySuccess(
          encodeArtifactQueryResult({
            kind: 'revision_changed',
            expected: input.revision,
            actual: page.revision,
          }),
        );
      }
      if (
        decodedOffset === undefined ||
        (input.kind === 'list_continue' && (offset === 0 || offset >= page.total))
      ) {
        return invalidQuery('Artifact cursor is invalid');
      }
      return querySuccess(
        createPage(input.sessionId, page.revision, page.records, page.total, offset),
      );
    } catch {
      return persistenceFailure('artifact.query', 'Artifact projection is unavailable');
    }
  }

  async #delete(input: {
    readonly sessionId: string;
    readonly artifactId: string;
  }): Promise<OperationOutcome<'artifact.delete'>> {
    try {
      const deleted = await this.#store.deleteUserArtifactInSession(
        input.sessionId,
        input.artifactId,
      );
      if (deleted.kind === 'not_found') {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Artifact was not found' },
        };
      }
      if (deleted.kind === 'protected') {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Protected runtime evidence cannot be deleted through Runtime Host',
          },
        };
      }
      return {
        ok: true,
        result: encodeArtifactDeleteResult({
          kind: 'deleted',
          artifact: encodeArtifactProjection(deleted.record),
        }),
      };
    } catch {
      this.#requestDrain();
      return persistenceFailure('artifact.delete', 'Artifact deletion could not be committed');
    }
  }
}

function createPage(
  sessionId: string,
  revision: ArtifactRevision,
  records: readonly ArtifactRecord[],
  total: number,
  offset: number,
): ArtifactQueryResult {
  const pageArtifacts: ArtifactProjection[] = [];
  for (const record of records) {
    const artifact = encodeArtifactProjection(record);
    const candidateArtifacts = [...pageArtifacts, artifact];
    const nextOffset = offset + candidateArtifacts.length;
    const candidate: ArtifactQueryResult = {
      kind: 'page',
      sessionId,
      revision,
      artifacts: candidateArtifacts,
      nextCursor: nextOffset < total ? String(nextOffset) : null,
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
    nextCursor: nextOffset < total ? String(nextOffset) : null,
  });
}

function decodeCursor(cursor: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function encodeTextResult(
  result: Extract<ArtifactQueryResult, { kind: 'text' }>,
): ArtifactQueryResult {
  if (
    result.preview.ok &&
    Buffer.byteLength(result.preview.text, 'utf8') > ARTIFACT_PREVIEW_MAX_BYTES
  ) {
    return encodeArtifactQueryResult({
      ...result,
      preview: { ok: false, reason: 'too_large' },
    });
  }
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
