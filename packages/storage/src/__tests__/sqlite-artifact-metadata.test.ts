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
      upserts: [unchanged, { ...updated, status: 'deleted' }, artifactRecord('added')],
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
        .readAll()
        .map(({ id, status }) => ({ id, status }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: 'added', status: 'live' },
        { id: 'unchanged', status: 'live' },
        { id: 'updated', status: 'deleted' },
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

function artifactRecord(id: string): ArtifactRecord {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    createdAt: 1,
    name: `${id}.txt`,
    kind: 'file',
    sizeBytes: id.length,
    relativePath: `session-1/${id}-${id}.txt`,
    source: 'fixture',
    status: 'live',
  };
}
