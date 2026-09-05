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
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '../operational-state-store.js';
import { createSqliteArtifactMetadataRepository } from '../sqlite-artifact-metadata.js';

// Count actual returned rows and decoded fixture JSON, not timings or SQL text.
// The target Session stays fixed as unrelated metadata grows by two orders of magnitude.
for (const backgroundCount of [100, 12_000]) {
  test(`ordinary Artifact operations read only their scope with ${backgroundCount} unrelated records`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-artifact-scoped-reads-'));
    const authority = createSqliteArtifactStoreWriteAuthority(root);
    const repository = createSqliteArtifactMetadataRepository(root);
    const lease = acquireOperationalStateDatabase(root);
    const { store } = authority;
    try {
      const inputs = Array.from({ length: 10 }, (_, i) => ({
        id: `target-${i}`,
        sessionId: 'target-session',
        turnId: i < 5 ? 'selected-turn' : 'other-turn',
        name: `target-${i}.txt`,
        kind: 'file' as const,
        content: `payload-${i}`,
        source: i === 9 ? ('session_effect' as const) : ('tool_result' as const),
        now: i,
      }));
      const target: ArtifactRecord[] = [];
      for (const input of inputs) target.push(await store.create(input));
      const linked = await store.create({
        ...inputs[0]!,
        id: 'linked',
        sessionId: 'linked-session',
        content: 'linked bytes',
      });
      const background = Array.from(
        { length: backgroundCount },
        (_, i): ArtifactRecord => ({
          id: `background-${i}`,
          sessionId: `background-session-${i % 100}`,
          turnId: 'background-turn',
          name: 'record.txt',
          kind: 'file',
          source: 'tool_result',
          createdAt: i,
          sizeBytes: 0,
          relativePath: `background-session-${i % 100}/background-${i}-record.txt`,
        }),
      );
      repository.applyChanges({ upserts: background });
      const fixtureJsons = new Set(
        [...target, linked, ...background].map((record) => JSON.stringify(record)),
      );
      const backgroundJsons = new Set(background.map((record) => JSON.stringify(record)));
      let rows = 0;
      let decoded = 0;
      let unrelatedDecoded = 0;
      const prepare = lease.database.prepare.bind(lease.database);
      t.mock.method(lease.database, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        if (/\bSELECT\b/i.test(sql) && /\bartifact_records\b/i.test(sql)) {
          const all = statement.all.bind(statement);
          const get = statement.get.bind(statement);
          t.mock.method(statement, 'all', (...params: SQLInputValue[]) => {
            const result = all(...params);
            rows += result.length;
            return result;
          });
          t.mock.method(statement, 'get', (...params: SQLInputValue[]) => {
            const result = get(...params);
            if (result) rows++;
            return result;
          });
        }
        return statement;
      });
      const parse = JSON.parse;
      t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
        if (fixtureJsons.has(args[0])) decoded++;
        if (backgroundJsons.has(args[0])) unrelatedDecoded++;
        return parse(...args);
      });
      async function expectReads(label: string, count: number, operation: () => Promise<unknown>) {
        rows = decoded = unrelatedDecoded = 0;
        await operation();
        assert.equal(rows, count, `${label}: returned rows`);
        assert.equal(decoded, count, `${label}: decoded records`);
        assert.equal(unrelatedDecoded, 0, `${label}: unrelated records`);
      }

      await expectReads('create', 0, () =>
        store.create({
          ...inputs[0]!,
          id: 'new-record',
          sessionId: 'new-session',
        }),
      );
      await expectReads('replay', 1, async () => {
        assert.deepEqual(await store.create(inputs[0]!), target[0]);
      });
      await expectReads('text', 1, async () => {
        assert.deepEqual(await store.readTextInSession('target-session', 'target-0'), {
          ok: true,
          text: 'payload-0',
        });
      });
      await expectReads('binary', 1, async () => {
        assert.deepEqual(await store.readBinaryInSession('target-session', 'target-0'), {
          ok: false,
          reason: 'unsupported_mime',
        });
      });
      await expectReads('chunk', 1, async () => {
        const result = await store.readChunkInSession('target-session', 'target-0', {
          offset: 0,
          maxBytes: 4,
        });
        assert.ok(result.ok);
        assert.equal(Buffer.from(result.bytes).toString(), 'payl');
      });
      await expectReads('durable attachment', 1, () =>
        store.readDurableAttachmentBinary({
          sessionId: 'target-session',
          artifactId: 'target-0',
        }),
      );
      await expectReads('wrong Session', 1, async () => {
        assert.deepEqual(await store.readTextInSession('wrong-session', 'target-0'), {
          ok: false,
          reason: 'not_found',
        });
      });
      await expectReads('wrong attachment Session', 1, async () => {
        assert.deepEqual(
          await store.readDurableAttachmentBinary({
            sessionId: 'wrong-session',
            artifactId: 'target-0',
          }),
          { ok: false, reason: 'session_mismatch' },
        );
      });
      await expectReads('missing attachment', 0, async () => {
        assert.deepEqual(
          await store.readDurableAttachmentBinary({
            sessionId: 'target-session',
            artifactId: 'missing',
          }),
          { ok: false, reason: 'not_found' },
        );
      });
      await expectReads('list page', 10, async () => {
        const page = await store.listPage('target-session', { offset: 2, limit: 2 });
        assert.equal(page.total, 10);
        assert.deepEqual(
          page.records.map((record) => record.id),
          ['target-7', 'target-6'],
        );
      });
      await expectReads('get with Session revision', 10, async () => {
        assert.deepEqual(
          (await store.getInSession('target-session', 'target-0')).record,
          target[0],
        );
      });
      await expectReads('list turn', 10, async () => {
        assert.deepEqual(
          (await store.listTurnArtifacts('target-session', 'selected-turn')).map(
            (record) => record.id,
          ),
          ['target-4', 'target-3', 'target-2', 'target-1', 'target-0'],
        );
      });
      await expectReads('protected delete', 1, async () => {
        assert.equal(
          (await store.deleteUserArtifactInSession('target-session', 'target-9')).kind,
          'protected',
        );
      });
      await expectReads('missing delete', 0, async () => {
        assert.equal(
          (await store.deleteUserArtifactInSession('target-session', 'missing')).kind,
          'not_found',
        );
      });
      await expectReads('wrong owner', 1, () =>
        assert.rejects(
          () => store.deleteOwnedArtifactInSession('wrong-session', 'target-0', 'tool_result'),
          /does not belong/,
        ),
      );
      await expectReads('empty purge', 0, () => store.purgeSessionArtifacts('empty-session'));
      await expectReads('copy source and explicit links', 11, async () => {
        const copied = await store.copyConversationArtifacts({
          sourceSessionId: 'target-session',
          targetSessionId: 'copy-session',
          turnIds: ['selected-turn'],
          excludeArtifactIds: ['target-1'],
          includeArtifactIds: ['target-0', 'target-6', 'missing'],
          linkedArtifacts: [
            { sessionId: 'linked-session', artifactIds: ['linked', 'linked', 'missing'] },
          ],
        });
        assert.deepEqual(
          [...copied.artifactIds.keys()],
          ['target-0', 'target-2', 'target-3', 'target-4', 'linked', 'target-6'],
        );
      });
    } finally {
      t.mock.restoreAll();
      lease.close();
      repository.close();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('conversation copy selects source and linked metadata from the same committed snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-copy-snapshot-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  const lease = acquireOperationalStateDatabase(root);
  let writer: DatabaseSync | undefined;
  try {
    const records: ArtifactRecord[] = [];
    for (const id of ['source', 'linked']) {
      records.push(
        await authority.store.create({
          id,
          sessionId: `${id}-session`,
          turnId: 'turn',
          name: 'record.txt',
          kind: 'file',
          source: 'tool_result',
          content: id,
          summary: 'before',
          now: 1,
        }),
      );
    }
    writer = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    const update = writer.prepare(
      'UPDATE artifact_records SET record_json = ? WHERE artifact_id = ?',
    );
    const prepare = lease.database.prepare.bind(lease.database);
    let changedBetweenQueries = false;
    t.mock.method(lease.database, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (/\bSELECT\b/i.test(sql) && /\bartifact_records\b/i.test(sql)) {
        const all = statement.all.bind(statement);
        t.mock.method(statement, 'all', (...params: SQLInputValue[]) => {
          const rows = all(...params);
          if (!changedBetweenQueries && params[0] === 'source-session') {
            changedBetweenQueries = true;
            for (const record of records) {
              update.run(JSON.stringify({ ...record, summary: 'after' }), record.id);
            }
          }
          return rows;
        });
      }
      return statement;
    });
    const copied = await authority.store.copyConversationArtifacts({
      sourceSessionId: 'source-session',
      targetSessionId: 'copy-session',
      turnIds: ['turn'],
      linkedArtifacts: [{ sessionId: 'linked-session', artifactIds: ['linked'] }],
    });
    assert.ok(changedBetweenQueries);
    for (const record of records) {
      const copiedId = copied.artifactIds.get(record.id);
      assert.ok(copiedId);
      assert.equal(
        (await authority.store.getInSession('copy-session', copiedId)).record?.summary,
        'before',
      );
      assert.equal(
        (await authority.store.getInSession(record.sessionId, record.id)).record?.summary,
        'after',
      );
      assert.deepEqual(await authority.store.readTextInSession('copy-session', copiedId), {
        ok: true,
        text: record.id,
      });
    }
  } finally {
    t.mock.restoreAll();
    writer?.close();
    lease.close();
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Session ordering and revision keep locale ID ties, independent of SQLite ordering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-order-'));
  const authority = createSqliteArtifactStoreWriteAuthority(root);
  try {
    const records = [];
    for (const id of ['B', 'a', 'A', 'b']) {
      records.push(
        await authority.store.create({
          id,
          sessionId: 'session',
          turnId: 'turn',
          name: 'record.txt',
          kind: 'file',
          source: 'tool_result',
          content: id,
          now: 1,
        }),
      );
    }
    const sorted = records.sort((left, right) => left.id.localeCompare(right.id));
    const revision = `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
    const page = await authority.store.listPage('session', { offset: 1, limit: 2 });
    assert.deepEqual(page.records, sorted.slice(1, 3));
    assert.equal(page.total, 4);
    assert.equal(page.revision, revision);
    assert.equal((await authority.store.getInSession('session', 'a')).revision, revision);
    assert.deepEqual(await authority.store.listTurnArtifacts('session', 'turn'), sorted);
  } finally {
    authority.close();
    await rm(root, { recursive: true, force: true });
  }
});
