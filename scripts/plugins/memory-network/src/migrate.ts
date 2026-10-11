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

import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Upgrade only recognized layouts, before the normal store performs any writes. */
export function migrateStore(directory: string) {
  const path = join(directory, 'network.sqlite');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  let backup: string | undefined;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const columns = db
      .prepare('PRAGMA table_info(memory_source_scans)')
      .all()
      .map((r) => String(r.name));
    const hasMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_meta'")
      .get();
    const scoped =
      hasMeta && db.prepare("SELECT 1 FROM memory_meta WHERE key='scan-scope-v1'").get();
    const upgradeScan = columns.length > 0 && (!scoped || !columns.includes('scope'));
    const hasWorkers = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workers'")
      .get();
    const workers = hasWorkers
      ? db
          .prepare('SELECT index_id,payload FROM workers')
          .all()
          .map((row) => ({ id: String(row.index_id), value: JSON.parse(String(row.payload)) }))
      : [];
    const legacy = workers.filter(
      (w) => w.value.groupIndexIds !== undefined && w.value.groupMembers === undefined,
    );
    if (!upgradeScan && !legacy.length) return;
    const backupPath = path + '.pre-scope-groups-' + randomUUID() + '.bak';
    closeSync(openSync(backupPath, 'wx', 0o600));
    // SQLite's snapshot includes committed WAL pages; copying just the main file does not.
    db.prepare('VACUUM INTO ?').run(backupPath);
    backup = backupPath;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Do not replace worker updates made by another process during backup.
      for (const { id, value } of workers) {
        const current = db.prepare('SELECT payload FROM workers WHERE index_id=?').get(id);
        if (
          !current ||
          JSON.stringify(JSON.parse(String(current.payload))) !== JSON.stringify(value)
        )
          throw Error('Workers changed during upgrade; retry once other writers are stopped');
      }
      if (upgradeScan) {
        const shape = [...columns].sort().join(',');
        if (!['payload,source', 'payload,scope,source'].includes(shape))
          throw Error('Unsupported memory_source_scans schema; supply the old DDL');
        if (!columns.includes('scope'))
          db.exec("ALTER TABLE memory_source_scans ADD COLUMN scope TEXT NOT NULL DEFAULT ''");
        // Legacy fingerprint/pagination encoding is unknown. Only unpublished staging is retired.
        db.exec('DELETE FROM memory_source_scans');
        if (
          db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_source_scan_items'",
            )
            .get()
        )
          db.exec('DELETE FROM memory_source_scan_items');
        db.exec(
          "CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT); INSERT OR REPLACE INTO memory_meta(key,value) VALUES('scan-scope-v1','1')",
        );
      }
      const byId = new Map(workers.map((w) => [w.id, w.value]));
      for (const { id, value } of legacy) {
        const ids = value.groupIndexIds;
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.some((x) => typeof x !== 'string') ||
          new Set(ids).size !== ids.length ||
          !ids.includes(id) ||
          !value.sessionId
        )
          throw Error('Unsupported legacy groupIndexIds; supply a redacted worker payload');
        for (const member of ids) {
          const peer = byId.get(member);
          const peerIds = peer?.groupMembers ?? peer?.groupIndexIds;
          if (
            !db.prepare('SELECT 1 FROM indexes WHERE id=?').get(member) ||
            peer?.sessionId !== value.sessionId ||
            JSON.stringify(peerIds) !== JSON.stringify(ids)
          )
            throw Error('Ambiguous legacy group membership/session; old workers were retained');
        }
        db.prepare('UPDATE workers SET payload=? WHERE index_id=?').run(
          JSON.stringify({ ...value, groupMembers: ids }),
          id,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    throw Error(
      `Memory database upgrade failed; original data retained${backup ? '; backup: ' + backup : ''}: ${String(error)}`,
      { cause: error },
    );
  } finally {
    db.close();
  }
}
