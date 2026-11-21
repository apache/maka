import type { Db } from './database'

interface Migration {
  version: number
  /** 语句列表：逐条 prepare().run() 执行，整体包在一个事务里 */
  up: string[]
}

/** 迁移只追加、不修改——已发布版本的历史不可变 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: [
      `
      CREATE TABLE bookmarks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        title      TEXT NOT NULL,
        url        TEXT NOT NULL,
        url_key    TEXT NOT NULL,
        category   TEXT NOT NULL DEFAULT '',
        note       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      )
      `,
      'CREATE INDEX idx_bookmarks_deleted ON bookmarks(deleted_at)',
      'CREATE INDEX idx_bookmarks_category ON bookmarks(category) WHERE deleted_at IS NULL',
      // 活跃书签 URL 唯一（回收站内不占用）；url_key 已做 trim+去尾斜杠归一
      'CREATE UNIQUE INDEX idx_bookmarks_url_active ON bookmarks(url_key) WHERE deleted_at IS NULL',
    ],
  },
]

export function migrate(db: Db): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `).run()
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<
    { version: number }
  >
  const applied = new Set(appliedRows.map((r) => r.version))

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    db.exec('BEGIN')
    try {
      for (const sql of m.up) {
        db.prepare(sql).run()
      }
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
