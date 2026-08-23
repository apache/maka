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
  decodeSessionCatalogItem,
  decodeSessionCatalogQueryResult,
  HOST_OPERATION_SPECS,
  SESSION_CATALOG_PAGE_MAX_ITEMS,
  SESSION_CATALOG_RUNNING_TURN_MAX_ITEMS,
  type SessionCatalogProjection,
} from '../protocol/index.js';

describe('Session catalog protocol', () => {
  test('decodes versioned live run state without collapsing absent and known-empty', () => {
    const unknown = projection();
    const knownEmpty = {
      ...projection(),
      liveRunState: { schemaVersion: 1, runningTurnIds: [] },
    };
    const running = {
      ...projection(),
      liveRunState: { schemaVersion: 1, runningTurnIds: ['turn-1', 'turn-2'] },
    };

    assert.deepEqual(decodeSessionCatalogItem(unknown), unknown);
    assert.deepEqual(decodeSessionCatalogItem(knownEmpty), knownEmpty);
    assert.deepEqual(decodeSessionCatalogItem(running), running);
  });

  test('rejects malformed or open live run state', () => {
    const liveRunState = { schemaVersion: 1, runningTurnIds: ['turn-1'] };

    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: { ...liveRunState, extra: true },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: { ...liveRunState, schemaVersion: 2 },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: { ...liveRunState, runningTurnIds: ['turn-1', 'turn-1'] },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: { ...liveRunState, runningTurnIds: 'turn-1' },
        }),
      isProtocolError,
    );
  });

  test('bounds the live running-turn collection explicitly', () => {
    const atLimit = Array.from(
      { length: SESSION_CATALOG_RUNNING_TURN_MAX_ITEMS },
      (_, index) => `turn-${index}`,
    );
    const projectionAtLimit = {
      ...projection(),
      liveRunState: { schemaVersion: 1, runningTurnIds: atLimit },
    };

    assert.deepEqual(decodeSessionCatalogItem(projectionAtLimit), projectionAtLimit);
    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: {
            schemaVersion: 1,
            runningTurnIds: [...atLimit, 'turn-overflow'],
          },
        }),
      isProtocolError,
    );
  });

  test('rejects sparse live running-turn arrays', () => {
    const runningTurnIds = Array<string>(1);

    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          liveRunState: { schemaVersion: 1, runningTurnIds },
        }),
      isProtocolError,
    );
  });

  test('identifies Session creation inputs that expose Host paths', () => {
    assert.equal(
      HOST_OPERATION_SPECS['session.create'].usesHostPaths?.({
        sessionId: 'project-session',
        workspace: { kind: 'project', projectId: 'project-1' },
        modelTarget: { kind: 'default' },
      }),
      false,
    );
    assert.equal(
      HOST_OPERATION_SPECS['session.create'].usesHostPaths?.({
        sessionId: 'path-session',
        workspace: { kind: 'host_path', path: '/workspace' },
        modelTarget: { kind: 'default' },
      }),
      true,
    );
  });

  test('decodes exact Session catalog invalidations', () => {
    const frame = {
      kind: 'session.catalog.changed' as const,
      revision: 1,
      sessionId: 'session-1',
    };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, revision: -1 }), isProtocolError);
    assert.throws(() => decodeHostFrame({ ...frame, extra: true }), isProtocolError);
  });

  test('decodes only bounded execution boundary summaries', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        input: { sessionId: 'session-1' },
      }),
      {
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        input: { sessionId: 'session-1' },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        ok: true,
        result: { kind: 'managed', access: 'read_only', revision: 3 },
      }),
      {
        requestId: 'request-1',
        operation: 'session.execution_boundary.query',
        ok: true,
        result: { kind: 'managed', access: 'read_only', revision: 3 },
      },
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-1',
          operation: 'session.execution_boundary.query',
          ok: true,
          result: { kind: 'managed', access: 'read_only', revision: 3, profile: {} },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.execution_boundary.query',
          input: { sessionId: 'session-1', includeProfile: true },
        }),
      isProtocolError,
    );
  });

  test('decodes exact stable creation and full replacement configuration inputs', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-1',
        operation: 'session.create',
        input: {
          sessionId: 'session-1',
          workspace: { kind: 'project', projectId: 'project-1' },
          name: 'Session',
          labels: ['catalog'],
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          thinkingLevel: 'high',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      }),
      {
        requestId: 'request-1',
        operation: 'session.create',
        input: {
          sessionId: 'session-1',
          workspace: { kind: 'project', projectId: 'project-1' },
          name: 'Session',
          labels: ['catalog'],
          modelTarget: {
            kind: 'explicit',
            connectionSlug: 'openai-main',
            model: 'gpt-5',
          },
          thinkingLevel: 'high',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
    );

    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-3',
        operation: 'session.workspace.relocate',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          workspace: { kind: 'host_path', path: '/workspace/next' },
        },
      }),
      {
        requestId: 'request-3',
        operation: 'session.workspace.relocate',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          workspace: { kind: 'host_path', path: '/workspace/next' },
        },
      },
    );

    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-2',
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'plan',
            orchestrationMode: 'graph',
          },
        },
      }),
      {
        requestId: 'request-2',
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-1',
          expectedRevision: 2,
          configuration: {
            modelTarget: { kind: 'default' },
            thinkingLevel: null,
            permissionMode: 'bypass',
            collaborationMode: 'plan',
            orchestrationMode: 'graph',
          },
        },
      },
    );
  });

  test('rejects partial, empty, or open-ended mutation shapes', () => {
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-1',
          operation: 'session.metadata.update',
          input: {
            sessionId: 'session-1',
            expectedRevision: 1,
            patch: {},
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'session.configuration.update',
          input: {
            sessionId: 'session-1',
            expectedRevision: 1,
            configuration: {
              modelTarget: { kind: 'default' },
              thinkingLevel: null,
              permissionMode: 'ask',
              collaborationMode: 'agent',
            },
          },
        }),
      isProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-3',
          operation: 'session.read_marker.set',
          input: {
            sessionId: 'session-1',
            readThroughMessageId: 'message-1',
            timestamp: 1,
          },
        }),
      isProtocolError,
    );
  });

  test('accepts only filter-free Session catalog list inputs', () => {
    const revision = `sha256:${'a'.repeat(64)}` as const;
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-list',
        operation: 'session.catalog.query',
        input: { kind: 'list_start' },
      }),
      {
        requestId: 'request-list',
        operation: 'session.catalog.query',
        input: { kind: 'list_start' },
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-continue',
        operation: 'session.catalog.query',
        input: { kind: 'list_continue', revision, cursor: 'cursor-1' },
      }),
      {
        requestId: 'request-continue',
        operation: 'session.catalog.query',
        input: { kind: 'list_continue', revision, cursor: 'cursor-1' },
      },
    );
    for (const filter of [{ isArchived: false }, { isFlagged: true }, { labelSlug: 'paged' }]) {
      assert.throws(
        () =>
          decodeClientFrame({
            requestId: 'request-reject',
            operation: 'session.catalog.query',
            input: { kind: 'list_start', filter },
          }),
        isProtocolError,
      );
      assert.throws(
        () =>
          decodeClientFrame({
            requestId: 'request-reject',
            operation: 'session.catalog.query',
            input: { kind: 'list_continue', revision, cursor: 'cursor-1', filter },
          }),
        isProtocolError,
      );
    }
  });

  test('accepts the complete 80-code-point Session name range', () => {
    const name = '🦊'.repeat(80);
    const decoded = decodeClientFrame({
      requestId: 'request-name',
      operation: 'session.create',
      input: {
        sessionId: 'session-name',
        workspace: { kind: 'host_path', path: '/workspace' },
        name,
        modelTarget: { kind: 'default' },
      },
    });
    if ('kind' in decoded) assert.fail('Expected Session create frame');
    assert.equal(decoded.operation, 'session.create');
    if (decoded.operation !== 'session.create') assert.fail('Expected Session create frame');
    assert.equal(decoded.input.name, name);
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-name-overflow',
          operation: 'session.create',
          input: {
            sessionId: 'session-name-overflow',
            workspace: { kind: 'host_path', path: '/workspace' },
            name: '🦊'.repeat(81),
            modelTarget: { kind: 'default' },
          },
        }),
      isProtocolError,
    );
  });

  test('accepts only declared Session start modes', () => {
    const decoded = decodeClientFrame({
      requestId: 'request-mode',
      operation: 'session.create',
      input: {
        sessionId: 'session-mode',
        workspace: { kind: 'host_path', path: '/workspace' },
        mode: 'deep_research',
        modelTarget: { kind: 'default' },
      },
    });
    if ('kind' in decoded || decoded.operation !== 'session.create') {
      assert.fail('Expected Session create frame');
    }
    assert.equal(decoded.input.mode, 'deep_research');
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-invalid-mode',
          operation: 'session.create',
          input: {
            sessionId: 'session-invalid-mode',
            workspace: { kind: 'host_path', path: '/workspace' },
            mode: 'unknown',
            modelTarget: { kind: 'default' },
          },
        }),
      isProtocolError,
    );
  });

  test('correlates committed and conflicting update outputs with the request Session', () => {
    const session = projection();
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-1',
        operation: 'session.metadata.update',
        ok: true,
        result: { kind: 'committed', session },
      }),
      {
        requestId: 'request-1',
        operation: 'session.metadata.update',
        ok: true,
        result: { kind: 'committed', session },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        requestId: 'request-2',
        operation: 'session.configuration.update',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        },
      }),
      {
        requestId: 'request-2',
        operation: 'session.configuration.update',
        ok: true,
        result: {
          kind: 'revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        },
      },
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.metadata.update'].assertOutputForInput?.(
          {
            sessionId: 'session-1',
            expectedRevision: 1,
            patch: { name: 'Renamed' },
          },
          {
            kind: 'committed',
            session: projection({ id: 'different-session' }),
          },
        ),
      isProtocolError,
    );
  });

  test('rejects a Host path projection whose target and cwd disagree', () => {
    assert.throws(
      () =>
        decodeSessionCatalogItem({
          ...projection(),
          workspace: {
            target: { kind: 'host_path', path: '/workspace' },
            hostCwd: '/different-workspace',
          },
        }),
      isProtocolError,
    );
  });

  test('normalizes legacy Session statuses in catalog projections', () => {
    for (const status of ['review', 'done']) {
      const decoded = decodeSessionCatalogItem({ ...projection(), status });
      if ('kind' in decoded) assert.fail('Expected a Session catalog projection');
      assert.equal(decoded.status, 'active');
    }
  });

  test('rejects unknown Session statuses in catalog projections', () => {
    assert.throws(
      () => decodeSessionCatalogItem({ ...projection(), status: 'unknown' }),
      isInvalidSessionStatus,
    );
  });

  test('bounds pages and preserves revision-pinned continuation results', () => {
    const sessions = Array.from({ length: SESSION_CATALOG_PAGE_MAX_ITEMS }, (_, index) =>
      projection({ id: `session-${index}` }),
    );
    const page = {
      kind: 'page' as const,
      revision: `sha256:${'a'.repeat(64)}` as const,
      sessions,
      nextCursor: '32',
    };
    assert.deepEqual(decodeSessionCatalogQueryResult(page), page);
    assert.throws(
      () =>
        decodeSessionCatalogQueryResult({
          ...page,
          sessions: [...sessions, projection({ id: 'overflow' })],
        }),
      isProtocolError,
    );
    const changed = {
      kind: 'revision_changed' as const,
      expectedRevision: `sha256:${'a'.repeat(64)}` as const,
      actualRevision: `sha256:${'b'.repeat(64)}` as const,
    };
    assert.deepEqual(decodeSessionCatalogQueryResult(changed), changed);
  });
});

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: {
      target: { kind: 'host_path', path: '/workspace' },
      hostCwd: '/workspace',
    },
    createdAt: 1,
    lastUsedAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError;
}

function isInvalidSessionStatus(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.message === 'Invalid Session status';
}
