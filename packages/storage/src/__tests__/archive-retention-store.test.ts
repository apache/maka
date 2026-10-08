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

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import {
  type ArchiveRetentionDocument,
  openArchiveRetentionStore,
  readArchiveRetentionDocument,
} from '../archive-retention-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

const DOCUMENT: ArchiveRetentionDocument = {
  version: 1,
  revision: 4,
  enabled: true,
  days: 60,
  enabledAt: 1_000,
  latest: {
    observedAt: 8_000,
    lastSweep: { at: 9_000, deleted: 2, skippedBusy: 1, needsReview: 0, failed: 0 },
    lastDeletion: { at: 9_000, count: 2, bytes: 512 },
    hold: { since: 1_000, detectedAt: 9_000, until: 95_400 },
  },
};

describe('archive retention document', () => {
  test('round-trips through the State Root and reads a missing file as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-archive-retention-'));
    const owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner);
    try {
      const store = openArchiveRetentionStore(owner.lease);
      assert.deepEqual(await store.read(), { kind: 'absent' });
      await store.write(DOCUMENT);
      assert.deepEqual(await store.read(), { kind: 'valid', document: DOCUMENT });
      const disabled: ArchiveRetentionDocument = {
        version: 1,
        revision: 5,
        enabled: false,
        days: 30,
      };
      await store.write(disabled);
      assert.deepEqual(await store.read(), { kind: 'valid', document: disabled });
      // A document the reader would refuse is never published.
      await assert.rejects(store.write({ ...disabled, enabledAt: 1 }));
      assert.deepEqual(
        JSON.parse(await readFile(join(root, 'archive-retention.json'), 'utf8')),
        disabled,
      );
    } finally {
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reads anything it cannot fully validate as invalid, never as a setting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-archive-retention-invalid-'));
    const write = (value: string) => writeFile(join(root, 'archive-retention.json'), value);
    try {
      for (const value of [
        'not json',
        JSON.stringify({ ...DOCUMENT, version: 2 }),
        JSON.stringify({ ...DOCUMENT, days: 45 }),
        JSON.stringify({ ...DOCUMENT, enabledAt: undefined }),
        JSON.stringify({ ...DOCUMENT, enabled: false }),
        JSON.stringify({ ...DOCUMENT, revision: -1 }),
        JSON.stringify({ ...DOCUMENT, extra: true }),
        JSON.stringify({ ...DOCUMENT, latest: { lastSweep: { at: 1 } } }),
        JSON.stringify({ ...DOCUMENT, latest: { lastDeletion: { at: 1, count: 1, bytes: 1.5 } } }),
        JSON.stringify({ ...DOCUMENT, latest: { hold: { since: 5, detectedAt: 4, until: 6 } } }),
        JSON.stringify({ ...DOCUMENT, latest: { observedAt: 1.5 } }),
      ]) {
        await write(value);
        assert.equal((await readArchiveRetentionDocument(root)).kind, 'invalid', value);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('archive retention candidates', () => {
  test('are the archived, unpinned rows Settings shows, oldest first, resumable', async () => {
    await withStore(async ({ store, setArchivedAt, sql }) => {
      const create = (overrides: Partial<SessionHeader>) => store.create(header(overrides));
      await create({ id: 'legacy', isArchived: true });
      await create({ id: 'old', isArchived: true });
      await create({ id: 'recent', isArchived: true });
      await create({
        id: 'recent-revision',
        isArchived: true,
        revisionRootSessionId: 'recent',
        revisionParentSessionId: 'recent',
        revisionOfTurnId: 'turn-1',
        revisionIndex: 2,
        revisionState: 'committed',
      });
      await create({ id: 'active' });
      await create({ id: 'pinned-root', isArchived: true });
      await create({
        id: 'pinned-revision',
        isArchived: true,
        isFlagged: true,
        revisionRootSessionId: 'pinned-root',
        revisionParentSessionId: 'pinned-root',
        revisionOfTurnId: 'turn-1',
        revisionIndex: 2,
        revisionState: 'committed',
      });
      await create({ id: 'live-parent', isArchived: true });
      await create({
        id: 'child',
        isArchived: true,
        subagentParent: subagentParent('live-parent'),
      });
      await create({ id: 'orphan', isArchived: true, subagentParent: subagentParent('gone') });
      await create({
        id: 'operator',
        isArchived: true,
        subagentParent: {
          ...subagentParent('gone'),
          graph: { graphId: 'graph', workId: 'work', operatorId: 'operator' },
        },
      });
      await create({ id: 'preparing', isArchived: true });
      sql(
        `UPDATE session_metadata
         SET payload_json = json_set(payload_json, '$.conversationCopy', json(?))
         WHERE session_id = ?`,
        JSON.stringify({
          kind: 'branch',
          sourceSessionId: 'legacy',
          sourceTurnId: 'turn-1',
          requestFingerprint: `sha256:${'a'.repeat(64)}`,
          state: 'preparing',
        }),
        'preparing',
      );
      await create({ id: 'unprojected', isArchived: true });
      sql('DELETE FROM session_catalog_projection WHERE session_id = ?', 'unprojected');
      setArchivedAt({
        legacy: null,
        old: 100,
        recent: 900,
        'live-parent': 200,
        orphan: 300,
        'recent-revision': 950,
      });

      const ids = async (query: Parameters<typeof store.listArchiveRetentionCandidates>[0]) =>
        (await store.listArchiveRetentionCandidates(query)).map((record) =>
          'undecodable' in record ? record.sessionId : record.header.id,
        );
      // A pinned revision keeps its whole family; a child whose parent exists is
      // that parent's row; a graph operator retires with its root; a preparing
      // copy and a row without a catalog projection are not on the page.
      assert.deepEqual(await ids({ limit: 50 }), [
        'legacy',
        'old',
        'live-parent',
        'orphan',
        'recent',
        'recent-revision',
      ]);
      // The cutoff keeps every unknown time and drops later ones.
      assert.deepEqual(await ids({ archivedBefore: 300, limit: 50 }), [
        'legacy',
        'old',
        'live-parent',
      ]);
      assert.deepEqual(await ids({ limit: 2 }), ['legacy', 'old']);
      assert.deepEqual(await ids({ after: { archivedAt: 100, sessionId: 'old' }, limit: 2 }), [
        'live-parent',
        'orphan',
      ]);
      assert.deepEqual(await ids({ after: { sessionId: 'legacy' }, limit: 1 }), ['old']);
      const [legacy, old] = await store.listArchiveRetentionCandidates({ limit: 2 });
      assert.equal(legacy?.archivedAt, undefined);
      assert.equal(old?.archivedAt, 100);

      // The preview's count: one per family, and the earliest family start
      // under a policy enabled at 150 (unknown and earlier times count from it).
      assert.deepEqual(await store.countArchiveRetentionCandidates(150), {
        families: 5,
        firstStart: 150,
      });
      assert.deepEqual(await store.countArchiveRetentionCandidates(1_000), {
        families: 5,
        firstStart: 1_000,
      });
    });
  });

  test('a row that no longer decodes is returned as such, in its place', async () => {
    await withStore(async ({ store, setArchivedAt, sql }) => {
      await store.create(header({ id: 'a-good', isArchived: true }));
      await store.create(header({ id: 'b-bad', isArchived: true }));
      setArchivedAt({ 'a-good': 10, 'b-bad': 20 });
      sql(
        "UPDATE session_metadata SET payload_json = json_set(payload_json, '$.createdAt', 'never') WHERE session_id = ?",
        'b-bad',
      );
      const rows = await store.listArchiveRetentionCandidates({ limit: 10 });
      assert.equal(rows.length, 2);
      assert.equal('undecodable' in rows[0]! ? 'bad' : rows[0]!.header.id, 'a-good');
      assert.deepEqual(rows[1], { undecodable: true, sessionId: 'b-bad', archivedAt: 20 });
    });
  });

  test('the newest metadata time comes from the committed and archive columns', async () => {
    await withStore(async ({ store, setArchivedAt, setClock }) => {
      setClock(50);
      await store.create(header({ id: 'a' }));
      await store.create(header({ id: 'b' }));
      setClock(70);
      await store.setArchivedVersioned([{ sessionId: 'a', expectedVersion: 1 }], true);
      assert.equal(await store.readLatestSessionMetadataTime(), 70);
      setArchivedAt({ a: 5_000 });
      assert.equal(await store.readLatestSessionMetadataTime(), 5_000);
    });
  });
});

async function withStore(
  operation: (rig: {
    store: ReturnType<typeof createSqliteSessionMetadataStore>;
    setArchivedAt(times: Record<string, number | null>): void;
    sql(statement: string, ...parameters: Array<string | number | null>): void;
    setClock(value: number): void;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-archive-retention-candidates-'));
  const path = join(root, 'state.sqlite');
  let clock = 10;
  const store = createSqliteSessionMetadataStore(path, { now: () => clock });
  try {
    await operation({
      store,
      setArchivedAt: (times) => {
        const database = new DatabaseSync(path);
        try {
          const update = database.prepare(
            'UPDATE session_metadata SET archived_at = ? WHERE session_id = ?',
          );
          for (const [id, archivedAt] of Object.entries(times)) update.run(archivedAt, id);
        } finally {
          database.close();
        }
      },
      sql: (statement, ...parameters) => {
        const database = new DatabaseSync(path);
        try {
          database.prepare(statement).run(...parameters);
        } finally {
          database.close();
        }
      },
      setClock: (value) => {
        clock = value;
      },
    });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function subagentParent(parentSessionId: string): NonNullable<SessionHeader['subagentParent']> {
  return {
    kind: 'subagent',
    parentSessionId,
    spawnedBy: { parentRunId: 'run', parentTurnId: 'turn', toolCallId: 'call' },
    lifecycle: 'foreground',
  };
}

function header(overrides: Partial<SessionHeader>): SessionHeader {
  return {
    id: 'session',
    workspaceRoot: '/workspace',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastMessageAt: 3,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 4,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-5',
    toolProfile: 'headless-coding-v1',
    thinkingLevel: 'high',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'swarm',
    schemaVersion: 1,
    ...overrides,
  };
}
