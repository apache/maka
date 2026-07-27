import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { migrateSqliteRuntimeDatabase } from '../sqlite-runtime-schema.js';

describe('SQLite runtime schema migration', () => {
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
