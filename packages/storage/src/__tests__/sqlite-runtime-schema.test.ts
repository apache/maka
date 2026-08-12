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

  it('coalesces legacy partial segments without materializing a complete stream', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrateSqliteRuntimeDatabase(db);
      db.prepare(`
        INSERT INTO runtime_partial_snapshots(
          stream_key, session_id, invocation_id, run_id, turn_id,
          after_event_id, payload_json, text_content, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run('stream-1', 'session-1', 'invocation-1', 'run-1', 'turn-1', '{}', 'prefix-', 1);
      db.prepare(`
        INSERT INTO runtime_partial_segments(stream_key, segment_seq, text_content, updated_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `).run('stream-1', 2, 'second', 2, 'stream-1', 1, 'first-', 1);
      db.exec('PRAGMA user_version = 12');

      migrateSqliteRuntimeDatabase(db);

      assert.deepEqual(
        db
          .prepare(`
            SELECT segment_seq, text_content, updated_at
            FROM runtime_partial_segments
            ORDER BY segment_seq
          `)
          .all()
          .map((row) => ({ ...row })),
        [{ segment_seq: 1, text_content: 'first-second', updated_at: 2 }],
      );
      assert.equal(
        (
          db.prepare('SELECT text_content FROM runtime_partial_snapshots').get() as {
            text_content: string;
          }
        ).text_content,
        'prefix-',
      );
      assert.equal(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        SQLITE_RUNTIME_SCHEMA_VERSION,
      );
    } finally {
      db.close();
    }
  });

  it('batches fragmented legacy partials into bounded target segments', () => {
    const db = new DatabaseSync(':memory:');
    try {
      migrateSqliteRuntimeDatabase(db);
      db.prepare(`
        INSERT INTO runtime_partial_snapshots(
          stream_key, session_id, invocation_id, run_id, turn_id,
          after_event_id, payload_json, text_content, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, '', ?)
      `).run('stream-1', 'session-1', 'invocation-1', 'run-1', 'turn-1', '{}', 1);
      const insert = db.prepare(`
        INSERT INTO runtime_partial_segments(stream_key, segment_seq, text_content, updated_at)
        VALUES ('stream-1', ?, ?, ?)
      `);
      for (let sequence = 1; sequence <= 300; sequence += 1) {
        insert.run(sequence, String(sequence % 10).repeat(1024), sequence);
      }
      db.exec('PRAGMA user_version = 12');

      migrateSqliteRuntimeDatabase(db);

      const segments = db
        .prepare(`
          SELECT segment_seq, length(CAST(text_content AS BLOB)) AS stored_bytes
          FROM runtime_partial_segments
          ORDER BY segment_seq
        `)
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(segments, [
        { segment_seq: 1, stored_bytes: 64 * 1024 },
        { segment_seq: 2, stored_bytes: 64 * 1024 },
        { segment_seq: 3, stored_bytes: 64 * 1024 },
        { segment_seq: 4, stored_bytes: 64 * 1024 },
        { segment_seq: 5, stored_bytes: 44 * 1024 },
      ]);
      const text = (
        db
          .prepare(`
            SELECT group_concat(text_content, '') AS text
            FROM (
              SELECT text_content FROM runtime_partial_segments ORDER BY segment_seq
            )
          `)
          .get() as { text: string }
      ).text;
      assert.equal(text.length, 300 * 1024);
      for (let index = 0; index < 300; index += 1) {
        assert.equal(
          text.slice(index * 1024, (index + 1) * 1024),
          String((index + 1) % 10).repeat(1024),
        );
      }
    } finally {
      db.close();
    }
  });
});
