import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate } from './migrations'

export type Db = DatabaseSync

/**
 * 打开（或创建）数据库并跑迁移。
 * Q7 定案：schema_migrations 版本表 + 启动时顺序执行未跑过的迁移。
 * 测试传 ':memory:' 得到隔离库。
 */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    // 首次运行时 data/ 目录尚不存在（被 .gitignore 排除），需先创建
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}
