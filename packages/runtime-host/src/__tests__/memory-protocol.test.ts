/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  encodeProtocolMessage,
  MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
  MEMORY_ENTRY_PAGE_MAX_ITEMS,
  MEMORY_RESULT_MAX_BYTES,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
} from '../protocol/index.js';

const revision = `sha256:${'a'.repeat(64)}` as const;

describe('Memory protocol', () => {
  test('accepts closed Memory operations and rejects open shapes', () => {
    assert.doesNotThrow(() =>
      request('memory.query', {
        kind: 'document_continue',
        document: 'memory',
        revision,
        cursor: 32,
      }),
    );
    assert.doesNotThrow(() =>
      request('memory.mutate', {
        kind: 'remember',
        expectedRevision: revision,
        title: 'Preference',
        content: 'Use concise answers.',
        scope: { kind: 'session', sessionId: 'session-1' },
      }),
    );
    assert.doesNotThrow(() =>
      request('memory.mutate', {
        kind: 'restore_backup',
        expectedRevision: revision,
        backupKind: 'save',
        expectedBackupRevision: revision,
      }),
    );
    assert.doesNotThrow(() =>
      mutationResponse({
        kind: 'backup_revision_conflict',
        backupKind: 'save',
        expectedRevision: revision,
        actualRevision: `sha256:${'b'.repeat(64)}`,
      }),
    );
    assert.throws(
      () =>
        request('memory.mutate', {
          kind: 'remember',
          expectedRevision: revision,
          title: 'Preference',
          content: 'Use concise answers.',
          scope: { kind: 'session' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        request('memory.query', {
          kind: 'document_start',
          document: 'memory',
          path: '/tmp/MEMORY.md',
        }),
      isInvalidFrame,
    );
  });

  test('keeps maximum document chunks inside both result and transport budgets', () => {
    const chunkBase64 = Buffer.alloc(MEMORY_DOCUMENT_CHUNK_MAX_BYTES, 0x61).toString('base64');
    const result = {
      kind: 'document_page' as const,
      document: 'memory' as const,
      revision,
      totalBytes: 128 * 1024,
      offset: 0,
      chunkBase64,
      nextCursor: MEMORY_DOCUMENT_CHUNK_MAX_BYTES,
    };
    assert.doesNotThrow(() => response('memory.query', result));
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MEMORY_RESULT_MAX_BYTES);
    assert.ok(
      encodeProtocolMessage({
        requestId: 'memory-page',
        operation: 'memory.query',
        ok: true,
        result,
      }).byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
    );

    const input = {
      kind: 'replace_chunk' as const,
      uploadId: 'upload-1',
      offset: 0,
      chunkBase64,
    };
    assert.doesNotThrow(() => request('memory.mutate', input));
    assert.ok(
      encodeProtocolMessage({
        requestId: 'memory-chunk',
        operation: 'memory.mutate',
        input,
      }).byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
    );
    assert.throws(
      () =>
        request('memory.mutate', {
          ...input,
          chunkBase64: Buffer.alloc(MEMORY_DOCUMENT_CHUNK_MAX_BYTES + 1).toString('base64'),
        }),
      isInvalidFrame,
    );
  });

  test('accepts an empty document page and rejects oversized entry projections', () => {
    assert.doesNotThrow(() =>
      response('memory.query', {
        kind: 'document_page',
        document: 'memory',
        revision,
        totalBytes: 0,
        offset: 0,
        chunkBase64: '',
        nextCursor: null,
      }),
    );

    const entry = {
      id: 'entry-1',
      source: 'user_authored',
      status: 'active',
      title: 'Preference',
      content: '\\'.repeat(4 * 1024),
      scope: 'workspace',
      tags: [],
    };
    const oversized = {
      kind: 'entries_page',
      view: 'active',
      revision,
      items: Array.from({ length: 16 }, (_, index) => ({ ...entry, id: `entry-${index}` })),
      nextCursor: null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > MEMORY_RESULT_MAX_BYTES);
    assert.throws(() => response('memory.query', oversized), isInvalidFrame);
    assert.throws(
      () =>
        response('memory.query', {
          ...oversized,
          items: Array.from({ length: MEMORY_ENTRY_PAGE_MAX_ITEMS + 1 }, (_, index) => ({
            ...entry,
            id: `entry-${index}`,
            content: 'bounded',
          })),
        }),
      isInvalidFrame,
    );
  });

  test('keeps failure codes operation-specific', () => {
    assert.doesNotThrow(() => failure('memory.query', 'persistence_failed'));
    assert.doesNotThrow(() => failure('memory.mutate', 'commit_outcome_unknown'));
    assert.throws(() => failure('memory.query', 'commit_outcome_unknown'), isInvalidFrame);
  });
});

function request(operation: 'memory.query' | 'memory.mutate', input: unknown): void {
  decodeClientFrame({ requestId: 'request', operation, input });
}

function response(operation: 'memory.query', result: unknown): void {
  decodeHostFrame({ requestId: 'response', operation, ok: true, result });
}

function mutationResponse(result: unknown): void {
  decodeHostFrame({ requestId: 'response', operation: 'memory.mutate', ok: true, result });
}

function failure(operation: 'memory.query' | 'memory.mutate', code: string): void {
  decodeHostFrame({
    requestId: 'response',
    operation,
    ok: false,
    error: { code, message: 'Memory operation failed' },
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
