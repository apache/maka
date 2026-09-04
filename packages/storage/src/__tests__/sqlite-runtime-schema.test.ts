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
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  SQLITE_RUNTIME_SCHEMA_VERSION,
  migrateSqliteRuntimeDatabase,
} from '../sqlite-runtime-schema.js';

describe('SQLite runtime schema migration', () => {
  it('uses the locked current version after an optimistic stale read', () => {
    const executed: string[] = [];
    let versionReads = 0;
    const db = {
      prepare(sql: string) {
        assert.equal(sql, 'PRAGMA user_version');
        return {
          get() {
            versionReads += 1;
            return {
              user_version: versionReads === 1 ? 4 : SQLITE_RUNTIME_SCHEMA_VERSION,
            };
          },
        };
      },
      exec(sql: string) {
        executed.push(sql);
      },
    } as unknown as DatabaseSync;

    migrateSqliteRuntimeDatabase(db);

    assert.equal(versionReads, 2);
    assert.deepEqual(executed, ['BEGIN IMMEDIATE', 'COMMIT']);
    assert.equal(
      executed.some((sql) => sql.includes('runtime_capabilities')),
      false,
    );
  });

  it('re-reads user_version under the write lock before applying migrations', () => {
    const real = new DatabaseSync(':memory:');
    let migrationLocked = false;
    let lockedVersionRead = false;
    const db = new Proxy(real, {
      get(target, property) {
        if (property === 'exec') {
          return (sql: string) => {
            const statement = sql.trim().toUpperCase();
            if (statement === 'BEGIN IMMEDIATE') migrationLocked = true;
            if (statement.includes('CREATE TABLE RUNTIME_EVENTS')) {
              assert.equal(
                lockedVersionRead,
                true,
                'pending migrations require a fresh user_version read under the write lock',
              );
            }
            try {
              return target.exec(sql);
            } finally {
              if (statement === 'COMMIT' || statement === 'ROLLBACK') {
                migrationLocked = false;
              }
            }
          };
        }
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.trim().toUpperCase() === 'PRAGMA USER_VERSION' && migrationLocked) {
              lockedVersionRead = true;
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseSync;

    try {
      migrateSqliteRuntimeDatabase(db);
      assert.equal(lockedVersionRead, true);
    } finally {
      real.close();
    }
  });

  it('preserves v1 continuation claims while admitting the v2 replay projection', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE runtime_events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL,
          event_kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          committed_at INTEGER NOT NULL
        );
        CREATE TABLE runtime_continuation_claims (
          claim_id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          source_invocation_id TEXT NOT NULL,
          source_run_id TEXT NOT NULL,
          source_turn_id TEXT NOT NULL,
          source_event_high_water INTEGER NOT NULL CHECK (source_event_high_water > 0),
          source_prefix_digest TEXT NOT NULL,
          boundary_digest TEXT NOT NULL UNIQUE,
          boundary_json TEXT NOT NULL,
          provider_projection_version INTEGER NOT NULL CHECK (provider_projection_version = 1),
          provider_replay_digest TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          target_invocation_id TEXT NOT NULL UNIQUE,
          target_run_id TEXT NOT NULL UNIQUE,
          target_turn_id TEXT NOT NULL,
          target_run_header_json TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          start_event_id TEXT UNIQUE REFERENCES runtime_events(event_id),
          start_kind TEXT CHECK (start_kind IS NULL OR start_kind IN ('runtime_admission', 'claim_repair')),
          protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
          UNIQUE (source_session_id, source_run_id, source_event_high_water, source_prefix_digest),
          UNIQUE (target_session_id, target_turn_id)
        );
        INSERT INTO runtime_continuation_claims VALUES (
          'claim-v1', 'session', 'source-invocation', 'source-run', 'source-turn', 1,
          'sha256:source', 'sha256:boundary-v1', '{}', 1, 'sha256:replay-v1',
          'session', 'target-invocation-v1', 'target-run-v1', 'target-turn-v1',
          '{"runId": "target-run-v1", "invocationId": "target-invocation-v1", "sessionId": "session", "turnId": "target-turn-v1", "status": "created", "backendKind": "fake", "llmConnectionSlug": "connection-1", "modelId": "model-1", "cwd": "/workspace", "permissionMode": "ask", "createdAt": 1, "updatedAt": 1}',
          1, NULL, NULL, 1
        );
        PRAGMA user_version = 14;
      `);

      migrateSqliteRuntimeDatabase(db);

      assert.equal(SQLITE_RUNTIME_SCHEMA_VERSION, 16);
      assert.equal(
        (
          db
            .prepare(
              "SELECT provider_projection_version AS version FROM runtime_continuation_claims WHERE claim_id = 'claim-v1'",
            )
            .get() as { version: number }
        ).version,
        1,
      );
      assert.equal(
        JSON.parse(
          (
            db
              .prepare(
                "SELECT target_opening_json AS opening FROM runtime_continuation_claims WHERE claim_id = 'claim-v1'",
              )
              .get() as { opening: string }
          ).opening,
        ).kind,
        'invocation_opened',
        'an open claim carries the opening it always implied, not a copy of the Run header',
      );
      db.exec(`
        INSERT INTO runtime_continuation_claims VALUES (
          'claim-v2', 'session', 'source-invocation', 'source-run', 'source-turn', 2,
          'sha256:source-2', 'sha256:boundary-v2', '{}', 2, 'sha256:replay-v2',
          'session', 'target-invocation-v2', 'target-run-v2', 'target-turn-v2', '{}',
          2, NULL, NULL, 1
        );
      `);
      assert.throws(() =>
        db.exec(`
          UPDATE runtime_continuation_claims
          SET provider_projection_version = 3
          WHERE claim_id = 'claim-v2'
        `),
      );
    } finally {
      db.close();
    }
  });
});
