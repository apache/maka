/**
 * 书签域运行时装配：SQLite 连接单例。
 * 挂 globalThis 对冲 dev 热重载；测试直接 openDatabase(':memory:')，不走这里。
 */

import path from 'node:path'
import { openDatabase, type Db } from './db/database'

const g = globalThis as typeof globalThis & {
  __bookmarkDb?: Db
  __bookmarkDbPath?: string
}

export function bookmarkDbPath(): string {
  return process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR, 'bookmarks.db')
    : path.resolve(process.cwd(), 'data/bookmarks.db')
}

export function getBookmarkDb(): Db {
  const p = bookmarkDbPath()
  if (g.__bookmarkDb && g.__bookmarkDbPath === p) return g.__bookmarkDb
  if (g.__bookmarkDb) {
    try {
      g.__bookmarkDb.close()
    } catch {
      // 已关闭
    }
  }
  const db = openDatabase(p)
  g.__bookmarkDb = db
  g.__bookmarkDbPath = p
  return db
}
