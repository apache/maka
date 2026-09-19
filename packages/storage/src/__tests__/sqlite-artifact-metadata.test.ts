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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { createSqliteArtifactMetadataRepository } from '../sqlite-artifact-metadata.js';

test('Artifact metadata changes only write changed rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-metadata-delta-'));
  const repository = createSqliteArtifactMetadataRepository(root);
  let inspector: DatabaseSync | undefined;
  try {
    const unchanged = artifactRecord('unchanged');
    const updated = artifactRecord('updated');
    const removed = artifactRecord('removed');
    repository.applyChanges({ upserts: [unchanged, updated, removed] });

    inspector = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    inspector.exec(`
      CREATE TABLE artifact_write_audit(kind TEXT NOT NULL);
      CREATE TRIGGER artifact_write_audit_insert AFTER INSERT ON artifact_records
      BEGIN INSERT INTO artifact_write_audit VALUES ('insert'); END;
      CREATE TRIGGER artifact_write_audit_update AFTER UPDATE ON artifact_records
      BEGIN INSERT INTO artifact_write_audit VALUES ('update'); END;
      CREATE TRIGGER artifact_write_audit_delete AFTER DELETE ON artifact_records
      BEGIN INSERT INTO artifact_write_audit VALUES ('delete'); END;
    `);

    repository.applyChanges({
      upserts: [unchanged, { ...updated, summary: 'changed' }, artifactRecord('added')],
      deleteIds: [removed.id],
    });

    const writes = inspector
      .prepare('SELECT kind, count(*) AS count FROM artifact_write_audit GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    assert.deepEqual(
      writes.map(({ kind, count }) => ({ kind, count })),
      [
        { kind: 'delete', count: 1 },
        { kind: 'insert', count: 1 },
        { kind: 'update', count: 1 },
      ],
    );
    assert.deepEqual(
      repository
        .listBySession('session-1')
        .map(({ id, summary }) => ({ id, summary }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: 'added', summary: undefined },
        { id: 'unchanged', summary: undefined },
        { id: 'updated', summary: 'changed' },
      ],
    );

    inspector.exec(`
      DROP TRIGGER artifact_write_audit_insert;
      DROP TRIGGER artifact_write_audit_update;
      DROP TRIGGER artifact_write_audit_delete;
      DROP TABLE artifact_write_audit;
    `);
  } finally {
    inspector?.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Artifact metadata recovery ignores records from unsupported sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-metadata-unsupported-'));
  const repository = createSqliteArtifactMetadataRepository(root);
  let inspector: DatabaseSync | undefined;
  try {
    const supported = artifactRecord('supported');
    repository.applyChanges({ upserts: [supported] });

    const unsupported = {
      ...artifactRecord('unsupported'),
      source: 'retired_artifact_source',
    };
    inspector = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    const insert = inspector.prepare(`
        INSERT INTO artifact_records(
          artifact_id,
          session_id,
          created_at,
          relative_path,
          record_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
    insert.run(
      unsupported.id,
      unsupported.sessionId,
      unsupported.createdAt,
      unsupported.relativePath,
      JSON.stringify(unsupported),
    );

    assert.deepEqual(repository.listBySession('session-1'), [supported]);
    assert.deepEqual(repository.getById(supported.id), supported);
    assert.equal(repository.getById(unsupported.id), null);
    assert.deepEqual(repository.readAllForPurgeSafety(), [supported]);
  } finally {
    inspector?.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Artifact metadata queries select only the requested identity or Session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-metadata-scope-'));
  const repository = createSqliteArtifactMetadataRepository(root);
  try {
    const first = artifactRecord('first');
    const second = { ...artifactRecord('second'), createdAt: 2 };
    const other = artifactRecord('other', 'session-2');
    repository.applyChanges({ upserts: [other, second, first] });

    assert.deepEqual(repository.getById(first.id), first);
    assert.equal(repository.getById('missing'), null);
    assert.deepEqual(repository.listBySession('session-1'), [first, second]);
    assert.deepEqual(repository.listBySession('session-2'), [other]);
    assert.deepEqual(repository.listBySession('missing'), []);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('indexed Artifact reads reject malformed JSON and inconsistent projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-metadata-invalid-'));
  const repository = createSqliteArtifactMetadataRepository(root);
  let inspector: DatabaseSync | undefined;
  try {
    const valid = artifactRecord('valid');
    repository.applyChanges({ upserts: [valid] });
    inspector = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    const insert = inspector.prepare(`
      INSERT INTO artifact_records(artifact_id, session_id, created_at, relative_path, record_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    const invalidRecords = [
      { id: 'bad-json', json: '{' },
      {
        id: 'bad-fields',
        json: JSON.stringify({ ...artifactRecord('bad-fields'), sizeBytes: -1 }),
      },
      { id: 'wrong-id', json: JSON.stringify(artifactRecord('different-id')) },
      { id: 'wrong-session', json: JSON.stringify(artifactRecord('wrong-session', 'session-2')) },
      { id: 'wrong-time', json: JSON.stringify({ ...artifactRecord('wrong-time'), createdAt: 2 }) },
      {
        id: 'wrong-path',
        json: JSON.stringify({
          ...artifactRecord('wrong-path'),
          name: 'other.txt',
          relativePath: 'session-1/wrong-path-other.txt',
        }),
      },
    ];
    for (const { id, json } of invalidRecords) {
      const projected = artifactRecord(id);
      insert.run(id, projected.sessionId, projected.createdAt, projected.relativePath, json);
      assert.equal(repository.getById(id), null, id);
    }
    assert.deepEqual(repository.listBySession('session-1'), [valid]);
    assert.deepEqual(repository.listBySession('session-2'), []);
    assert.equal(repository.getById('different-id'), null);
  } finally {
    inspector?.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('composed Artifact reads use one snapshot and release it on success or failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-metadata-snapshot-'));
  const repository = createSqliteArtifactMetadataRepository(root);
  let writer: DatabaseSync | undefined;
  try {
    const source = artifactRecord('source');
    const linked = artifactRecord('linked', 'linked-session');
    repository.applyChanges({ upserts: [source, linked] });
    writer = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    const update = writer.prepare(
      'UPDATE artifact_records SET record_json = ? WHERE artifact_id = ?',
    );
    const changed = { ...linked, summary: 'newly committed' };

    repository.withReadSnapshot(() => {
      assert.deepEqual(repository.listBySession(source.sessionId), [source]);
      update.run(JSON.stringify(changed), linked.id);
      assert.deepEqual(repository.getById(linked.id), linked);
    });
    assert.deepEqual(repository.getById(linked.id), changed);

    assert.throws(
      () =>
        repository.withReadSnapshot(() => {
          assert.deepEqual(repository.getById(linked.id), changed);
          update.run(JSON.stringify(linked), linked.id);
          throw new Error('selection failed');
        }),
      /selection failed/,
    );
    assert.deepEqual(repository.getById(linked.id), linked);
    repository.applyChanges({ upserts: [{ ...source, summary: 'still writable' }] });
    assert.equal(repository.getById(source.id)?.summary, 'still writable');
  } finally {
    writer?.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

function artifactRecord(id: string, sessionId = 'session-1'): ArtifactRecord {
  return {
    id,
    sessionId,
    turnId: 'turn-1',
    createdAt: 1,
    name: `${id}.txt`,
    kind: 'file',
    sizeBytes: id.length,
    relativePath: `${sessionId}/${id}-${id}.txt`,
    source: 'tool_result',
  };
}
