import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  decodeClientFrame,
  decodeHostFrame,
  encodeArtifactQueryResult,
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import { encodeArtifactProjection } from '../protocol/artifact.js';

const revision = `sha256:${'a'.repeat(64)}` as const;

describe('Artifact protocol', () => {
  test('registers only the closed ready query and delete operations', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('artifact.')),
      ['artifact.query', 'artifact.delete'],
    );
    assert.deepEqual(metadata('artifact.query'), {
      mode: 'query',
      availability: 'ready',
    });
    assert.deepEqual(metadata('artifact.delete'), {
      mode: 'command',
      availability: 'ready',
    });

    for (const input of [
      { kind: 'list_start', sessionId: 'session-1' },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: '128' },
      { kind: 'get', sessionId: 'session-1', artifactId: 'artifact-1' },
      { kind: 'read_text', sessionId: 'session-1', artifactId: 'artifact-1' },
      { kind: 'read_binary', sessionId: 'session-1', artifactId: 'artifact-1' },
    ]) {
      assert.doesNotThrow(() => request('artifact.query', input));
    }
    assert.doesNotThrow(() =>
      request('artifact.delete', { sessionId: 'session-1', artifactId: 'artifact-1' }),
    );

    for (const input of [
      { kind: 'list_start', sessionId: 'session-1', includeDeleted: false },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: '1', path: '/tmp' },
      { kind: 'get', sessionId: 'session-1', artifactId: 'artifact-1', relativePath: 'x' },
      { kind: 'read_chunk', sessionId: 'session-1', artifactId: 'artifact-1' },
      { kind: 'list_start' },
    ]) {
      assert.throws(() => request('artifact.query', input), isInvalidFrame);
    }
    assert.throws(
      () => request('artifact.delete', { sessionId: 'session-1', artifactId: 'a', purge: true }),
      isInvalidFrame,
    );
  });

  test('keeps operation failures closed and typed', () => {
    assert.doesNotThrow(() => failure('artifact.delete', 'not_found', 'Artifact was not found'));
    assert.doesNotThrow(() =>
      failure(
        'artifact.delete',
        'operation_conflict',
        'Protected runtime evidence cannot be deleted through Runtime Host',
      ),
    );
    assert.doesNotThrow(() =>
      failure('artifact.query', 'persistence_failed', 'Artifact projection is unavailable'),
    );
    assert.throws(
      () => failure('artifact.query', 'not_found', 'Artifact was not found'),
      isInvalidFrame,
    );
    assert.throws(
      () => failure('artifact.query', 'operation_conflict', 'Protected runtime evidence'),
      isInvalidFrame,
    );
    assert.throws(() => failure('artifact.delete', 'outcome_unknown', 'Unknown'), isInvalidFrame);
  });

  test('rejects paths, byte-overflowing strings, oversized pages, and oversized previews', () => {
    const artifact = validArtifact();
    assert.doesNotThrow(() =>
      response('artifact.query', {
        kind: 'page',
        sessionId: 'session-1',
        revision,
        artifacts: [{ ...artifact, turnId: 'future-runtime-kind:sequence/branch' }],
        nextCursor: null,
      }),
    );
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'artifact',
          sessionId: 'session-1',
          revision,
          artifact: { ...artifact, turnId: 'turn\n1' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'artifact',
          sessionId: 'session-1',
          revision,
          artifact: { ...artifact, relativePath: 'session-1/a.txt' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'artifact',
          sessionId: 'session-1',
          revision,
          artifact: { ...artifact, name: '\u754c'.repeat(171) },
        }),
      isInvalidFrame,
    );

    const byteHeavy = {
      kind: 'page' as const,
      sessionId: 'session-1',
      revision,
      artifacts: Array.from({ length: 6 }, (_, index) => ({
        ...artifact,
        id: `artifact-heavy-${index}`,
        summary: '\\'.repeat(8 * 1024),
      })),
      nextCursor: null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(byteHeavy), 'utf8') > ARTIFACT_RESULT_MAX_BYTES);
    assert.throws(() => response('artifact.query', byteHeavy), isInvalidFrame);
    assert.doesNotThrow(() =>
      response('artifact.query', {
        kind: 'text',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        preview: { ok: true, text: '' },
      }),
    );
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'page',
          sessionId: 'session-1',
          revision,
          artifacts: Array.from({ length: ARTIFACT_PAGE_MAX_ITEMS + 1 }, (_, index) => ({
            ...artifact,
            id: `artifact-${index}`,
          })),
          nextCursor: null,
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'text',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          preview: { ok: true, text: 'x'.repeat(ARTIFACT_PREVIEW_MAX_BYTES + 1) },
        }),
      isInvalidFrame,
    );
    const oversizedBinary = Buffer.alloc(ARTIFACT_PREVIEW_MAX_BYTES + 1).toString('base64');
    assert.throws(
      () =>
        response('artifact.query', {
          kind: 'binary',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          preview: { ok: true, base64: oversizedBinary, mimeType: 'image/png' },
        }),
      isInvalidFrame,
    );

    const maximumBinary = encodeArtifactQueryResult({
      kind: 'binary',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      preview: {
        ok: true,
        base64: Buffer.alloc(ARTIFACT_PREVIEW_MAX_BYTES).toString('base64'),
        mimeType: 'image/png',
      },
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(maximumBinary), 'utf8') <= ARTIFACT_RESULT_MAX_BYTES,
    );
    assert.ok(
      encodeProtocolFrame({
        requestId: 'artifact-binary',
        operation: 'artifact.query',
        ok: true,
        result: maximumBinary,
      }).byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES,
    );
  });

  test('projects producer records to canonical UTF-8 byte boundaries', () => {
    const record: ArtifactRecord = {
      ...validArtifact(),
      relativePath: 'session-1/artifact.txt',
      name: `\0${'a'.repeat(509)}tail`,
      mimeType: '\u754c'.repeat(171),
      summary: `\x7f${'\u754c'.repeat(3_000)}`,
    };

    const projected = encodeArtifactProjection(record);

    assert.equal(projected.name, `\ufffd${'a'.repeat(509)}`);
    assert.equal(Buffer.byteLength(projected.name, 'utf8'), ARTIFACT_NAME_MAX_BYTES);
    assert.equal(projected.mimeType, '\u754c'.repeat(170));
    assert.ok(Buffer.byteLength(projected.mimeType, 'utf8') <= ARTIFACT_MIME_TYPE_MAX_BYTES);
    assert.equal(projected.summary?.startsWith('\ufffd'), true);
    assert.ok(Buffer.byteLength(projected.summary ?? '', 'utf8') <= ARTIFACT_SUMMARY_MAX_BYTES);
    assert.equal('relativePath' in projected, false);
  });
});

function validArtifact() {
  return {
    id: 'artifact-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    createdAt: 1,
    name: 'artifact.txt',
    kind: 'file' as const,
    sizeBytes: 4,
    mimeType: 'text/plain',
    source: 'fixture' as const,
    summary: 'bounded',
    status: 'live' as const,
  };
}

function metadata(key: 'artifact.query' | 'artifact.delete') {
  const { mode, availability } = HOST_OPERATION_SPECS[key];
  return { mode, availability };
}

function request(operation: 'artifact.query' | 'artifact.delete', input: unknown): void {
  decodeClientFrame({ requestId: 'request', operation, input });
}

function response(operation: 'artifact.query', result: unknown): void {
  decodeHostFrame({ requestId: 'response', operation, ok: true, result });
}

function failure(
  operation: 'artifact.query' | 'artifact.delete',
  code: string,
  message: string,
): void {
  decodeHostFrame({
    requestId: 'response',
    operation,
    ok: false,
    error: { code, message },
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
