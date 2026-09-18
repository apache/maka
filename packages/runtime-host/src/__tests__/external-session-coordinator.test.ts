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

import { assertMaximalJsonPages } from './fixtures/json-pages.js';
import {
  EXTERNAL_SESSION_NAME_MAX_BYTES,
  EXTERNAL_SESSION_PAGE_MAX_ITEMS,
  EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES,
} from '../protocol/index.js';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExternalSessionAdapterRegistry,
  ExternalSessionCatalogCursorError,
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
  type ExternalSessionAdapter,
  type ExternalSessionCatalogPageQuery,
  type ExternalSessionSummary,
} from '@maka/core/external-session';
import { type SessionHeader } from '@maka/core/session';
import { headerToSummary } from '@maka/runtime/session-manager';
import type { SessionCatalogRecord } from '@maka/storage/execution-stores';
import { createExternalSessionAdapterRegistry } from '@maka/storage/external-sessions';
import {
  decodeResponseFrame,
  EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  EXTERNAL_SESSION_RESULT_MAX_BYTES,
} from '../protocol/index.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { HostExternalSessionCoordinator } from '../server/external-session-coordinator.js';
import {
  NoUsableImportModelError,
  SessionOperationFailure,
} from '../server/session-catalog-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'external-session-test-epoch',
  connectionId: 'external-session-test-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('discovers detected adapters and pages bounded source summaries', async () => {
  const adapter = adapterFixture({ count: 20 });
  const unavailable = adapterFixture({ id: 'unavailable', detected: false });
  const invalidId = adapterFixture({ id: 'invalid.source' });
  const fixture = coordinatorFixture([adapter, unavailable, invalidId]);

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.source.query']({}, context),
    { ok: true, result: { adapterIds: ['codex'] } },
  );

  const first = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('Expected the first catalog page');
  assert.equal(first.result.sessions.length, 16);
  assert.equal(first.result.nextCursor, '16');

  const second = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex', cursor: first.result.nextCursor ?? undefined },
    context,
  );
  assert.equal(second.ok, true);
  if (!second.ok) assert.fail('Expected the second catalog page');
  assert.equal(second.result.sessions.length, 4);
  assert.equal(second.result.nextCursor, null);
});

test('Codex filesystem keyset paging never repeats a row moved ahead of the cursor', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'maka-codex-catalog-keyset-'));
  try {
    const directory = join(codexHome, 'sessions', '2026', '09', '15');
    await mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = `snapshot-${String(index).padStart(2, '0')}`;
      const path = join(directory, `rollout-2026-09-15T00-00-00-${id}.jsonl`);
      await writeFile(
        path,
        `${JSON.stringify({
          timestamp: '2026-09-15T00:00:00.000Z',
          type: 'session_meta',
          payload: { id, cwd: '/workspace/root', source: 'cli' },
        })}\n${JSON.stringify({
          timestamp: '2026-09-15T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: id },
        })}`,
      );
      const time = new Date(Date.UTC(2026, 8, 15, 0, 0, index));
      await utimes(path, time, time);
      paths.push(path);
    }
    const adapter = createExternalSessionAdapterRegistry({ codex: { codexHome } }).require('codex');
    const fixture = coordinatorFixture([adapter]);
    const first = await fixture.coordinator.handlers['external-session.catalog.query'](
      { adapterId: 'codex' },
      context,
    );
    assert.ok(first.ok);
    assert.equal(first.result.sessions.length, 16);

    const newest = new Date('2026-09-16T00:00:00Z');
    await utimes(paths[1]!, newest, newest);
    const second = await fixture.coordinator.handlers['external-session.catalog.query'](
      { adapterId: 'codex', cursor: first.result.nextCursor ?? undefined },
      context,
    );
    assert.ok(second.ok);
    const ids = [...first.result.sessions, ...second.result.sessions].map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      ids,
      Array.from({ length: 20 }, (_, index) => 19 - index)
        .filter((index) => index !== 1)
        .map((index) => `snapshot-${String(index).padStart(2, '0')}`),
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('reports an invalid source-owned catalog cursor as invalid_request', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'maka-codex-invalid-catalog-cursor-'));
  try {
    await mkdir(join(codexHome, 'sessions'));
    const adapter = createExternalSessionAdapterRegistry({ codex: { codexHome } }).require('codex');
    const fixture = coordinatorFixture([adapter]);

    assert.deepEqual(
      await fixture.coordinator.handlers['external-session.catalog.query'](
        { adapterId: 'codex', cursor: 'not-a-codex-cursor' },
        context,
      ),
      {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'External Session catalog cursor is invalid',
        },
      },
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('Codex state keyset paging never repeats a row moved ahead of the cursor', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'maka-codex-state-catalog-snapshot-'));
  try {
    const directory = join(codexHome, 'sessions', '2026', '09', '15');
    await mkdir(directory, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
    try {
      database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        cwd TEXT,
        name TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        archived INTEGER,
        source TEXT
      )
    `);
      const insert = database.prepare(`
      INSERT INTO threads (
        id, rollout_path, cwd, name, created_at_ms, updated_at_ms, archived, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
      for (let index = 0; index < 20; index += 1) {
        const id = `snapshot-${String(index).padStart(2, '0')}`;
        const path = join(directory, `rollout-2026-09-15T00-00-00-${id}.jsonl`);
        await writeFile(
          path,
          `${JSON.stringify({
            timestamp: '2026-09-15T00:00:00.000Z',
            type: 'session_meta',
            payload: { id, cwd: '/workspace/root', source: 'cli' },
          })}\n`,
        );
        insert.run(id, path, '/workspace/root', id, index, index, 0, 'cli');
      }

      const adapter = createExternalSessionAdapterRegistry({ codex: { codexHome } }).require(
        'codex',
      );
      const fixture = coordinatorFixture([adapter]);
      const first = await fixture.coordinator.handlers['external-session.catalog.query'](
        { adapterId: 'codex' },
        context,
      );
      assert.ok(first.ok);
      assert.deepEqual(
        first.result.sessions.map(({ id }) => id),
        Array.from({ length: 16 }, (_, index) => `snapshot-${String(19 - index).padStart(2, '0')}`),
      );

      database.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(100, 'snapshot-01');
      const second = await fixture.coordinator.handlers['external-session.catalog.query'](
        { adapterId: 'codex', cursor: first.result.nextCursor ?? undefined },
        context,
      );
      assert.ok(second.ok);
      const ids = [...first.result.sessions, ...second.result.sessions].map(({ id }) => id);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(
        ids,
        Array.from({ length: 20 }, (_, index) => 19 - index)
          .filter((index) => index !== 1)
          .map((index) => `snapshot-${String(index).padStart(2, '0')}`),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test('advances the catalog cursor by source rows when an adapter row is not wire-safe', async () => {
  const summaries = Array.from({ length: 18 }, (_, index) => ({
    id: index === 5 ? 'invalid\u0000source' : `source-${index}`,
    name: `Source ${index}`,
    cwd: '/external',
    updatedAt: index,
  }));
  const adapter = adapterFixture();
  adapter.listSessionPage = async (query) => catalogPageFixtureSummaries(summaries, query);
  const fixture = coordinatorFixture([adapter]);

  const first = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('Expected the first catalog page');
  assert.equal(first.result.sessions.length, 15);
  assert.equal(first.result.nextCursor, '16');

  const second = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex', cursor: first.result.nextCursor ?? undefined },
    context,
  );
  assert.equal(second.ok, true);
  if (!second.ok) assert.fail('Expected the second catalog page');
  assert.equal(second.result.nextCursor, null);
  assert.deepEqual(
    [...first.result.sessions, ...second.result.sessions].map(({ id }) => id),
    summaries.filter(({ id }) => !id.includes('\u0000')).map(({ id }) => id),
  );
});

test('maps malformed source-owned catalog cursors to invalid_request', async () => {
  const adapter = adapterFixture();
  const fixture = coordinatorFixture([adapter]);

  for (const cursor of ['NaN', '-1', '1.5']) {
    const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
      { adapterId: 'codex', cursor },
      context,
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) assert.fail('Expected malformed cursor rejection');
    assert.equal(outcome.error.code, 'invalid_request');
  }
});

test('preserves typed source limits across the catalog Host boundary', async () => {
  const adapter = adapterFixture();
  adapter.listSessionPage = async () => {
    throw new ExternalSessionLimitError('records', 2, 'private adapter details');
  };
  const fixture = coordinatorFixture([adapter]);

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.deepEqual(outcome, {
    ok: false,
    error: {
      code: 'source_limit_exceeded',
      message: 'External Session source exceeds the catalog read limit',
    },
  });
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'catalog-limit',
      operation: 'external-session.catalog.query',
      ...outcome,
    }),
    {
      requestId: 'catalog-limit',
      operation: 'external-session.catalog.query',
      ...outcome,
    },
  );
});

test('resolves a Project filter before calling the Host adapter', async () => {
  const adapter = adapterFixture();
  const filters: unknown[] = [];
  adapter.listSessionPage = async (input) => {
    filters.push(input);
    return { items: [], hasMore: false };
  };
  const fixture = coordinatorFixture([adapter]);

  const result = await fixture.coordinator.handlers['external-session.catalog.query'](
    {
      adapterId: 'codex',
      workspace: { kind: 'project', projectId: 'project-1' },
      includeArchived: true,
    },
    context,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(filters, [
    {
      cwd: '/resolved-project',
      includeArchived: true,
      limit: EXTERNAL_SESSION_PAGE_MAX_ITEMS + 1,
    },
  ]);
});

test('projects zero import state for never-imported source Sessions with one batch lookup', async () => {
  const fixture = coordinatorFixture([adapterFixture({ count: 2 })]);

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(
    outcome.result.sessions.map(({ importState }) => importState),
    [
      { importedCount: 0, importedSessionIds: [], isImporting: false },
      { importedCount: 0, importedSessionIds: [], isImporting: false },
    ],
  );
  assert.deepEqual(fixture.lookupCalls, [
    {
      adapterId: 'codex',
      sourceSessionIds: ['source-0', 'source-1'],
      recentSessionIdLimit: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
    },
  ]);
});

test('projects the complete durable import count and newest eight imported Session ids', async () => {
  const importedSessionIds = Array.from({ length: 8 }, (_, index) => `imported-${12 - index}`);
  const fixture = coordinatorFixture([adapterFixture()], {
    lookupExternalSessionImports: async () => [
      {
        sourceSessionId: 'source-0',
        livePublishedImportCount: 12,
        recentSessionIds: importedSessionIds,
      },
    ],
  });

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(outcome.result.sessions[0]?.importState, {
    importedCount: 12,
    importedSessionIds,
    isImporting: false,
  });
});

test('reports an unresolved import independently from durable import history', async () => {
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseRead!: () => void;
  const readRelease = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const fixture = coordinatorFixture(
    [
      adapterFixture({
        readSession: async (sourceSessionId) => {
          markReadStarted();
          await readRelease;
          return {
            sourceSessionId,
            metadata: { name: 'Source 0', cwd: '/external' },
            messages: [{ type: 'user', id: 'message-1', turnId: 'turn-1', ts: 1, text: 'hello' }],
          };
        },
      }),
    ],
    {
      lookupExternalSessionImports: async () => [
        {
          sourceSessionId: 'source-0',
          livePublishedImportCount: 2,
          recentSessionIds: ['imported-2', 'imported-1'],
        },
      ],
    },
  );

  const importing = fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  await readStarted;
  const catalog = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(catalog.ok, true);
  if (!catalog.ok) assert.fail('Expected the external Session catalog');
  assert.deepEqual(catalog.result.sessions[0]?.importState, {
    importedCount: 2,
    importedSessionIds: ['imported-2', 'imported-1'],
    isImporting: true,
  });

  releaseRead();
  assert.equal((await importing).ok, true);
});

test('the largest row the wire bounds allow still shares a page', async () => {
  // The page budget is a packing limit only because one row is bounded well
  // below it, and that is what makes the over-budget branch unreachable. This
  // builds the largest row the wire bounds permit — every field at its cap, with
  // a full window of imported ids — and requires two of them to fit. Raising a
  // field bound past the budget fails here, instead of quietly costing the
  // catalog a row at runtime.
  const maxId = (suffix: string) =>
    `${'i'.repeat(EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES - 1)}${suffix}`;
  // The inputs are far larger than any field bound, so what reaches the page is
  // exactly the caps — which is what this test is about.
  const longestRow = (suffix: string) => ({
    id: maxId(suffix),
    name: 'n'.repeat(1024 * 1024),
    cwd: `/${'c'.repeat(1024 * 1024)}`,
  });
  const adapter = adapterFixture({ count: 2 });
  adapter.listSessionPage = async (query) =>
    catalogPageFixtureSummaries([longestRow('0'), longestRow('1')], query);
  const fixture = coordinatorFixture([adapter], {
    lookupExternalSessionImports: async (_adapterId, sourceSessionIds) =>
      sourceSessionIds.map((sourceSessionId) => ({
        sourceSessionId,
        livePublishedImportCount: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
        recentSessionIds: Array.from(
          { length: EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS },
          () => 'r'.repeat(EXTERNAL_SESSION_SOURCE_SESSION_ID_MAX_BYTES),
        ),
      })),
  });

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected a catalog page');
  // Two rows share the page, so neither needed the over-budget branch.
  assert.equal(outcome.result.sessions.length, 2);
  assert.equal(outcome.result.sessions[0]?.name.length, EXTERNAL_SESSION_NAME_MAX_BYTES);
  assert.equal(
    outcome.result.sessions[0]?.importState.importedSessionIds.length,
    EXTERNAL_SESSION_IMPORTED_SESSION_IDS_MAX_ITEMS,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <= EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
});

test('stops catalog pages before the encoded result limit', async () => {
  const adapter = adapterFixture({ count: 20 });
  adapter.listSessionPage = async (query) =>
    catalogPageFixtureSummaries(
      Array.from({ length: 20 }, (_, index) => ({
        id: `source-${index}`,
        name: `Source ${index}`,
        cwd: `/${'\u0000'.repeat(4_000)}`,
      })),
      query,
    );
  const fixture = coordinatorFixture([adapter], {
    lookupExternalSessionImports: async (_adapterId, sourceSessionIds) =>
      sourceSessionIds.map((sourceSessionId) => ({
        sourceSessionId,
        livePublishedImportCount: 8,
        recentSessionIds: Array.from(
          { length: 8 },
          (_, index) => `${sourceSessionId}-${index}-${'x'.repeat(100)}`,
        ),
      })),
  });

  const outcome = await fixture.coordinator.handlers['external-session.catalog.query'](
    { adapterId: 'codex' },
    context,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) assert.fail('Expected a bounded catalog page');
  assert.ok(outcome.result.sessions.length > 0);
  assert.ok(outcome.result.sessions.length < 16);
  assert.equal(outcome.result.nextCursor, String(outcome.result.sessions.length));
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.result), 'utf8') <= EXTERNAL_SESSION_RESULT_MAX_BYTES,
  );
  assert.equal(fixture.lookupCalls.length, 1);
  assert.equal(fixture.lookupCalls[0]?.sourceSessionIds.length, 16);
  const pages = [outcome.result];
  let cursor: string | null = outcome.result.nextCursor;
  while (cursor !== null) {
    const next = await fixture.coordinator.handlers['external-session.catalog.query'](
      { adapterId: 'codex', cursor },
      context,
    );
    assert.ok(next.ok && next.result.sessions.length > 0);
    pages.push(next.result);
    assert.ok(pages.length <= 20);
    cursor = next.result.nextCursor;
  }
  const items = pages.flatMap((page) => page.sessions);
  assert.deepEqual(
    items.map((item) => item.id),
    Array.from({ length: 20 }, (_, index) => `source-${index}`),
  );
  assertMaximalJsonPages(pages, items, {
    maxBytes: EXTERNAL_SESSION_RESULT_MAX_BYTES,
    maxItems: EXTERNAL_SESSION_PAGE_MAX_ITEMS,
    items: (page) => page.sessions,
    candidate: (page, sessions, end) => ({
      ...page,
      sessions,
      nextCursor: end < items.length ? String(end) : null,
    }),
  });
});

test('imports through the generic importer and treats repeats as independent copies', async () => {
  const fixture = coordinatorFixture([adapterFixture()]);

  const first = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  const second = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) assert.fail('Expected both imports to commit');
  assert.equal(first.result.kind, 'imported');
  assert.equal(second.result.kind, 'imported');
  if (first.result.kind !== 'imported' || second.result.kind !== 'imported')
    assert.fail('Expected imported Sessions');
  assert.notEqual(first.result.session.id, second.result.session.id);
  const response = { requestId: 'import-request', operation: 'external-session.import', ...first };
  assert.deepEqual(decodeResponseFrame(JSON.parse(JSON.stringify(response))), response);
  assert.deepEqual(
    fixture.creates.map(({ input, messages, externalOrigin }) => ({
      cwd: input.cwd,
      name: input.name,
      messageTypes: messages.map(({ type }) => type),
      externalOrigin,
    })),
    [
      {
        cwd: '/external',
        name: 'Source 0',
        messageTypes: ['user'],
        externalOrigin: { adapterId: 'codex', sourceSessionId: 'source-0' },
      },
      {
        cwd: '/external',
        name: 'Source 0',
        messageTypes: ['user'],
        externalOrigin: { adapterId: 'codex', sourceSessionId: 'source-0' },
      },
    ],
  );
  assert.equal(fixture.drainRequests(), 0);
});

test('coalesces a repeat import issued while the first is still running', async () => {
  // The surface that asks cannot enforce this. 导入任务 is a Settings page the
  // user is free to leave mid-import — the import deliberately continues here —
  // and the page's in-flight state dies with it, so coming back and pressing
  // 导入 again used to land a second task for one intent. A second window or
  // the CLI would have done the same. Nothing is awaited between the two calls
  // below, which is exactly that: two requests for one source, both live.
  const fixture = coordinatorFixture([adapterFixture()]);

  const [first, second] = await Promise.all([
    fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) assert.fail('Expected the coalesced import to commit');
  if (first.result.kind !== 'imported' || second.result.kind !== 'imported')
    assert.fail('Expected imported Sessions');
  // Same task, and only one of them was ever created. Both callers are told
  // about it, so the one that clicked twice still gets taken to the result.
  assert.equal(first.result.session.id, second.result.session.id);
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.drainRequests(), 0);

  // Only concurrent repeats collapse. Once the first has settled the source is
  // importable again, which is the deliberate second-copy behaviour pinned by
  // the test above.
  const later = await fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  assert.equal(later.ok, true);
  if (!later.ok || later.result.kind !== 'imported')
    assert.fail('Expected a later repeat to commit its own copy');
  assert.notEqual(later.result.session.id, first.result.session.id);
  assert.equal(fixture.creates.length, 2);
});

test('reports conversion errors before persistence and store uncertainty after entry', async () => {
  let createAttempts = 0;
  const conversionFailure = coordinatorFixture(
    [
      adapterFixture({
        readSession: async () => {
          throw new Error('malformed rollout');
        },
      }),
    ],
    {
      createImportedSession: async () => {
        createAttempts += 1;
        assert.fail('Conversion failure must not enter persistence');
      },
    },
  );
  assert.deepEqual(
    await conversionFailure.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'source_unreadable',
        message: 'External Session could not be read or converted',
      },
    },
  );
  assert.equal(createAttempts, 0);
  assert.equal(conversionFailure.drainRequests(), 0);

  const canonicalizationFailure = coordinatorFixture([
    adapterFixture({
      readSession: async (sourceSessionId) => ({
        sourceSessionId,
        metadata: { name: 'Invalid time', cwd: '/external' },
        messages: [
          {
            type: 'user',
            id: 'message-1',
            turnId: 'turn-1',
            ts: -1,
            text: 'hello',
          },
        ],
      }),
    }),
  ]);
  assert.deepEqual(
    await canonicalizationFailure.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'source_unreadable',
        message: 'External Session could not be read or converted',
      },
    },
  );
  assert.equal(canonicalizationFailure.creates.length, 0);
  assert.equal(canonicalizationFailure.drainRequests(), 0);

  const persistenceFailure = coordinatorFixture([adapterFixture()], {
    createImportedSession: async () => {
      throw new Error('commit acknowledgement lost');
    },
  });
  assert.deepEqual(
    await persistenceFailure.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'commit_outcome_unknown',
        message:
          'External Session import outcome is unknown; check the Session list before retrying',
      },
    },
  );
  assert.equal(persistenceFailure.drainRequests(), 1);
});

test('classifies source absence only through the adapter error authority', async () => {
  for (const [error, code] of [
    [new ExternalSessionNotFoundError(), 'not_found'],
    [new Error('transcript not found'), 'source_unreadable'],
  ] as const) {
    const fixture = coordinatorFixture([
      adapterFixture({
        readSession: async () => {
          throw error;
        },
      }),
    ]);
    const result = await fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    );
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('Expected source read failure');
    assert.equal(result.error.code, code);
  }
});

test('carries visible Claude transcript limits through the import response before persistence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'maka-claude-import-limit-'));
  try {
    const sourceSessionId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const directory = join(home, 'projects', '-private-workspace');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${sourceSessionId}.jsonl`),
      [
        {
          type: 'user',
          cwd: '/private/workspace',
          message: { role: 'user', content: 'x'.repeat(512) },
        },
        {
          type: 'assistant',
          message: {
            id: 'reply',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n'),
    );
    for (const [options, kind, max] of [
      [{ maxTranscriptBytes: 100 }, 'transcript_bytes', 100],
      [{ maxRecordBytes: 100 }, 'record_bytes', 100],
      [{ maxRecords: 1 }, 'records', 1],
      [{ maxMessages: 1 }, 'messages', 1],
      // The response collector and final message converter both retain bytes.
      [{ maxConvertedBytes: 10 }, 'converted_bytes', 10],
      [{ maxConvertedBytes: 300 }, 'converted_bytes', 300],
    ] as const) {
      const adapter = createExternalSessionAdapterRegistry({
        claudeCode: { claudeHome: home, ...options },
      }).require('claude-code');
      const fixture = coordinatorFixture([adapter]);
      const catalog = await fixture.coordinator.handlers['external-session.catalog.query'](
        { adapterId: 'claude-code' },
        context,
      );
      assert.ok(catalog.ok);
      assert.equal(catalog.result.sessions[0]?.id, sourceSessionId);

      const outcome = await fixture.coordinator.handlers['external-session.import'](
        { adapterId: 'claude-code', sourceSessionId },
        context,
      );
      assert.deepEqual(outcome, {
        ok: true,
        result: { kind: 'source_limit_exceeded', limit: { kind, max } },
      });
      const response = {
        requestId: 'limit-request',
        operation: 'external-session.import',
        ...outcome,
      };
      assert.deepEqual(decodeResponseFrame(JSON.parse(JSON.stringify(response))), response);
      assert.equal(fixture.creates.length, 0);
      assert.equal(fixture.drainRequests(), 0);
      const settled = await fixture.coordinator.handlers['external-session.catalog.query'](
        { adapterId: 'claude-code' },
        context,
      );
      assert.ok(settled.ok);
      assert.equal(settled.result.sessions[0]?.importState.isImporting, false);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('does not classify untyped source errors or errors after persistence as source limits', async () => {
  const untyped = coordinatorFixture([
    adapterFixture({
      readSession: async () => {
        throw Object.assign(new Error('record exceeds 100 bytes: /private/transcript.jsonl'), {
          limit: { kind: 'record_bytes', max: 100 },
        });
      },
    }),
  ]);
  assert.deepEqual(
    await untyped.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'source_unreadable',
        message: 'External Session could not be read or converted',
      },
    },
  );
  const committed = coordinatorFixture([adapterFixture()], {
    createImportedSession: async () => {
      throw new ExternalSessionLimitError('record_bytes', 100, 'private persistence details');
    },
  });
  const outcome = await committed.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  assert.ok(!outcome.ok);
  assert.equal(outcome.error.code, 'commit_outcome_unknown');
  assert.equal(committed.drainRequests(), 1);
});

test('reports a model-target failure before any commit is attempted', async () => {
  let createAttempts = 0;
  const fixture = coordinatorFixture([adapterFixture()], {
    resolveTarget: async () => {
      throw new NoUsableImportModelError(
        'No usable Session model connection is available for import',
      );
    },
    createImportedSession: async () => {
      createAttempts += 1;
      assert.fail('A model-target failure must not enter persistence');
    },
  });

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'model_unavailable',
        message: 'No usable Session model connection is available for import',
      },
    },
  );
  assert.equal(createAttempts, 0);
  assert.equal(fixture.drainRequests(), 0);
});

test('reports an unsupported adapter as invalid_request, not a source-unreadable failure', async () => {
  // Guards the shell mapping: only the dedicated `source_unreadable` code becomes
  // the "too large or malformed" banner. An unknown adapter is a bad request and
  // must stay generic rather than blame the source conversation.
  const fixture = coordinatorFixture([adapterFixture()]);

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'unknown-adapter', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: { code: 'invalid_request', message: 'External Session source is unsupported' },
    },
  );
});

test('removes an imported Session when its model history cannot be prepared', async () => {
  const fixture = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      throw new Error('ledger repair failed');
    },
  });

  assert.deepEqual(
    await fixture.coordinator.handlers['external-session.import'](
      { adapterId: 'codex', sourceSessionId: 'source-0' },
      context,
    ),
    {
      ok: false,
      error: {
        code: 'persistence_failed',
        message: 'External Session history could not be prepared',
      },
    },
  );
  assert.equal(fixture.hasRecord('imported-1'), false);
  assert.equal(fixture.drainRequests(), 0);
});

test('holds Session admission through failed history preparation and cleanup', async () => {
  let markPreparationStarted!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    markPreparationStarted = resolve;
  });
  let releasePreparation!: () => void;
  const preparationRelease = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let discarded = false;
  const fixture = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      markPreparationStarted();
      await preparationRelease;
      throw new Error('ledger repair failed');
    },
    discardImportedSession: async () => {
      discarded = true;
    },
  });

  const importing = fixture.coordinator.handlers['external-session.import'](
    { adapterId: 'codex', sourceSessionId: 'source-0' },
    context,
  );
  await preparationStarted;
  let competingAdmissionEntered = false;
  const competingAdmission = fixture.admission.run('imported-1', () => {
    competingAdmissionEntered = true;
    assert.equal(discarded, true);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(competingAdmissionEntered, false);

  releasePreparation();
  const outcome = await importing;
  await competingAdmission;

  assert.equal(outcome.ok, false);
  assert.equal(competingAdmissionEntered, true);
  assert.equal(fixture.drainRequests(), 0);
});

test('recovers or discards staged imported Sessions after restart', async () => {
  const recovered = coordinatorFixture([adapterFixture()]);
  await recovered.seedStagingSession();
  assert.equal(recovered.readHeader('imported-1')?.transcriptLedgerVersion, 0);

  await recovered.coordinator.recover();

  assert.equal(recovered.readHeader('imported-1')?.transcriptLedgerVersion, 1);

  const discarded = coordinatorFixture([adapterFixture()], {
    prepareImportedSessionHistory: async () => {
      throw new Error('ledger repair failed');
    },
  });
  await discarded.seedStagingSession();

  await discarded.coordinator.recover();

  assert.equal(discarded.hasRecord('imported-1'), false);
  assert.equal(discarded.drainRequests(), 0);
});

function coordinatorFixture(
  adapters: readonly ExternalSessionAdapter[],
  storeOverrides: Partial<
    Pick<HostStore, 'createImportedSession' | 'lookupExternalSessionImports'> & {
      prepareImportedSessionHistory(sessionId: string): Promise<void>;
      discardImportedSession(sessionId: string): Promise<void>;
      resolveTarget(): Promise<{
        readonly backend: 'ai-sdk';
        readonly llmConnectionSlug: string;
        readonly model: string;
        readonly permissionMode: 'ask';
        readonly collaborationMode: 'agent';
        readonly orchestrationMode: 'default';
      }>;
    }
  > = {},
) {
  let sequence = 0;
  let drains = 0;
  const admission = new SessionAdmissionGate();
  const records = new Map<string, SessionCatalogRecord>();
  const creates: Array<{
    input: Parameters<HostStore['createImportedSession']>[0];
    messages: Parameters<HostStore['createImportedSession']>[1];
    externalOrigin: Parameters<HostStore['createImportedSession']>[2];
  }> = [];
  const lookupCalls: Array<{
    adapterId: string;
    sourceSessionIds: readonly string[];
    recentSessionIdLimit: number;
  }> = [];
  const defaultCreate: HostStore['createImportedSession'] = async (
    input,
    messages,
    externalOrigin,
    options,
  ) => {
    options?.onCommitStarted?.();
    sequence += 1;
    const header = {
      ...sessionHeader(`imported-${sequence}`, input.cwd, input.name ?? 'Imported'),
      transcriptLedgerVersion: 0 as const,
    };
    creates.push({ input, messages, externalOrigin });
    records.set(header.id, {
      header,
      revision: 1,
      committedAt: 1,
      activityAt: header.lastMessageAt ?? header.createdAt,
      summary: headerToSummary(header),
    });
    return header;
  };
  const store: HostStore = {
    createImportedSession: async (input, messages, externalOrigin, options) => {
      if (!storeOverrides.createImportedSession) {
        return defaultCreate(input, messages, externalOrigin, options);
      }
      options?.onCommitStarted?.();
      return storeOverrides.createImportedSession(input, messages, externalOrigin, options);
    },
    lookupExternalSessionImports: async (adapterId, sourceSessionIds, recentSessionIdLimit) => {
      lookupCalls.push({ adapterId, sourceSessionIds, recentSessionIdLimit });
      return (
        storeOverrides.lookupExternalSessionImports?.(
          adapterId,
          sourceSessionIds,
          recentSessionIdLimit,
        ) ?? []
      );
    },
    listHeaders: async () => [...records.values()].map((record) => record.header),
    readCatalogRecord: async (sessionId) => {
      const record = records.get(sessionId);
      if (!record) throw new Error(`missing record: ${sessionId}`);
      return record;
    },
  };
  return {
    coordinator: new HostExternalSessionCoordinator({
      adapters: new ExternalSessionAdapterRegistry(adapters),
      admission,
      sessions: store,
      workspaceResolver: {
        resolve: async (target) =>
          target.kind === 'host_path'
            ? { target, cwd: target.path, projectId: null }
            : {
                target,
                cwd: '/resolved-project',
                projectId: target.projectId,
                project: {
                  id: target.projectId,
                  name: 'Project',
                  locations: [{ path: '/resolved-project', isWorktree: false }],
                  available: true,
                  preferredPath: '/resolved-project',
                },
              },
      },
      resolveTarget:
        storeOverrides.resolveTarget ??
        (async () => ({
          backend: 'ai-sdk',
          llmConnectionSlug: 'default',
          model: 'gpt-5',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        })),
      prepareImportedSessionHistory:
        storeOverrides.prepareImportedSessionHistory ??
        (async (sessionId) => {
          const record = records.get(sessionId);
          if (!record) throw new Error(`missing record: ${sessionId}`);
          const header = { ...record.header, transcriptLedgerVersion: 1 as const };
          records.set(sessionId, {
            ...record,
            header,
            revision: record.revision + 1,
            summary: headerToSummary(header),
          });
        }),
      discardImportedSession:
        storeOverrides.discardImportedSession ??
        (async (sessionId) => {
          records.delete(sessionId);
        }),
      requestDrain: () => {
        drains += 1;
      },
    }),
    creates,
    lookupCalls,
    admission,
    seedStagingSession: () =>
      defaultCreate(
        {
          cwd: '/external',
          llmConnectionSlug: 'default',
          model: 'gpt-5',
          permissionMode: 'ask',
        },
        [],
        { adapterId: 'codex', sourceSessionId: 'source-0' },
      ),
    readHeader: (sessionId: string) => records.get(sessionId)?.header,
    hasRecord: (sessionId: string) => records.has(sessionId),
    drainRequests: () => drains,
  };
}

type HostStore = ConstructorParameters<typeof HostExternalSessionCoordinator>[0]['sessions'];

function adapterFixture(
  options: {
    id?: string;
    detected?: boolean;
    count?: number;
    readSession?: ExternalSessionAdapter['readSession'];
  } = {},
): ExternalSessionAdapter {
  const count = options.count ?? 1;
  return {
    id: options.id ?? 'codex',
    detect: async () => options.detected ?? true,
    listSessionPage: async (query) =>
      catalogPageFixtureSummaries(
        Array.from({ length: count }, (_, index) => ({
          id: `source-${index}`,
          name: `Source ${index}`,
          cwd: '/external',
          updatedAt: index,
        })),
        query,
      ),
    readSession:
      options.readSession ??
      (async (sourceSessionId) => ({
        sourceSessionId,
        metadata: { name: 'Source 0', cwd: '/external' },
        messages: [
          {
            type: 'user',
            id: 'message-1',
            turnId: 'turn-1',
            ts: 1,
            text: 'hello',
          },
        ],
      })),
  };
}

function sessionHeader(id: string, cwd: string, name: string): SessionHeader {
  return {
    id,
    workspaceRoot: '/workspace',
    cwd,
    createdAt: 1,
    name,
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    schemaVersion: 1,
  };
}

/**
 * One page of a fixture source, the way a real adapter answers a query.
 *
 * The fixture materialises its rows and slices them; a real adapter pages
 * inside its own store, which is the property the coordinator's cursor is not
 * allowed to depend on.
 */
function pageFixtureSummaries<T>(
  summaries: readonly T[],
  query: { readonly offset?: number; readonly limit?: number } = {},
): readonly T[] {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? summaries.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Invalid external Session adapter page');
  }
  return summaries.slice(offset, offset + limit);
}

function catalogPageFixtureSummaries<T extends ExternalSessionSummary>(
  summaries: readonly T[],
  query: ExternalSessionCatalogPageQuery,
) {
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ExternalSessionCatalogCursorError();
  }
  const page = pageFixtureSummaries(summaries, { offset, limit: query.limit });
  return {
    items: page.map((summary, index) => ({
      summary,
      nextCursor: String(offset + index + 1),
    })),
    hasMore: offset + page.length < summaries.length,
  };
}
