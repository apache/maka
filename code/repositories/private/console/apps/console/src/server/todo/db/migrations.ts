import type { Db } from './database'

interface Migration {
  version: number
  up: string
}

/** 迁移只追加、不修改——已发布版本的历史不可变（Q7 定案） */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE todos (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL,
        description  TEXT,
        status       TEXT NOT NULL CHECK (status IN ('todo','doing','done')) DEFAULT 'todo',
        priority     TEXT CHECK (priority IN ('low','medium','high')),
        due_date     TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        completed_at TEXT,
        deleted_at   TEXT
      );
      CREATE INDEX idx_todos_status ON todos(status) WHERE deleted_at IS NULL;

      CREATE TABLE conversations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id),
        role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
        content         TEXT NOT NULL DEFAULT '',
        raw_json        TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id);
    `,
  },
]

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<
    { version: number }
  >
  const applied = new Set(appliedRows.map((r) => r.version))

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN')
    try {
      db.exec(m.up)
      db
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}
