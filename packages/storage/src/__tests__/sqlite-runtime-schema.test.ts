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
});
