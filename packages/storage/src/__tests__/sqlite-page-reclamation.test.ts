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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readSqliteAutoVacuumMode,
  readSqliteFreelistPages,
  runBoundedIncrementalVacuum,
} from '../sqlite-page-reclamation.js';

test('bounded incremental vacuum reclaims freelist pages on incremental databases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'page-reclamation-'));
  const path = join(root, 'offload.sqlite');
  const DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, value BLOB)');
    const blob = Buffer.alloc(64 * 1024, 1);
    for (let index = 0; index < 8; index += 1) {
      db.prepare('INSERT INTO payload (value) VALUES (?)').run(blob);
    }
    db.exec('DELETE FROM payload');
    assert.equal(readSqliteAutoVacuumMode(db), 'incremental');
    assert.ok(readSqliteFreelistPages(db) > 0);
    const result = runBoundedIncrementalVacuum(db, 64);
    assert.ok(result.reclaimedPages > 0);
    assert.ok(result.reclaimedBytes > 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
