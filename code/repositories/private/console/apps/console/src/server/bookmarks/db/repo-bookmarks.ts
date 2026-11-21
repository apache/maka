import type { Bookmark, CategoryStat, DuplicateGroup } from '@ggbdpq/console-shared/bookmarks'
import { conflict } from '@ggbdpq/console-shared/bookmarks'
import type { Db } from './database'
import { duplicateKey, urlKey } from '../url-key'

interface BookmarkRow {
  id: number
  title: string
  url: string
  url_key: string
  category: string
  note: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function toEntity(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    category: row.category,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

const BASE_COLUMNS = `id, title, url, url_key, category, note, created_at, updated_at, deleted_at`

export interface BookmarkPatch {
  title?: string
  url?: string
  category?: string
  note?: string
}

export interface ListParams {
  q?: string
  category?: string
  view?: 'active' | 'trash'
  limit: number
  offset: number
}

function buildWhere(params: ListParams): { sql: string; args: string[] } {
  const clauses = [params.view === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL']
  const args: string[] = []
  if (params.category) {
    clauses.push('category = ?')
    args.push(params.category)
  }
  if (params.q) {
    // LIKE 通配符转义：% 和 _ 按字面搜索
    const like = `%${params.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    clauses.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')")
    args.push(like, like, like)
  }
  return { sql: clauses.join(' AND '), args }
}

export function listBookmarks(db: Db, params: ListParams): { items: Bookmark[]; total: number } {
  const where = buildWhere(params)
  const rows = db
    .prepare(
      `SELECT ${BASE_COLUMNS} FROM bookmarks WHERE ${where.sql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...where.args, params.limit, params.offset) as unknown as BookmarkRow[]
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE ${where.sql}`)
    .get(...where.args) as unknown as { n: number }
  return { items: rows.map(toEntity), total: totalRow.n }
}

/** 按 id 取书签，含回收站内的（恢复/彻底删除需要看到软删行） */
export function getBookmark(db: Db, id: number): Bookmark | null {
  const row = db
    .prepare(`SELECT ${BASE_COLUMNS} FROM bookmarks WHERE id = ?`)
    .get(id) as unknown as BookmarkRow | undefined
  return row ? toEntity(row) : null
}

function hasActiveUrl(db: Db, key: string, excludeId?: number): boolean {
  const row = db
    .prepare('SELECT id FROM bookmarks WHERE url_key = ? AND deleted_at IS NULL AND id != COALESCE(?, -1)')
    .get(key, excludeId ?? null) as unknown as { id: number } | undefined
  return row !== undefined
}

export interface CreateInput {
  title: string
  url: string
  category?: string
  note?: string
  /** 导入路径携带导出文件里的原始添加时间；手动新增省略即 now */
  createdAt?: string
}

export function createBookmark(db: Db, input: CreateInput): Bookmark {
  const key = urlKey(input.url)
  if (hasActiveUrl(db, key)) {
    throw conflict(`已存在相同 URL 的书签：${input.url.trim()}`)
  }
  const now = new Date().toISOString()
  const result = db
    .prepare(
      `INSERT INTO bookmarks (title, url, url_key, category, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.title, input.url.trim(), key, input.category ?? '', input.note ?? '', input.createdAt ?? now, now)
  return getBookmark(db, Number(result.lastInsertRowid))!
}

export function updateBookmark(db: Db, id: number, patch: BookmarkPatch): Bookmark | null {
  const current = getBookmark(db, id)
  if (!current) return null

  if (patch.url !== undefined && urlKey(patch.url) !== urlKey(current.url)) {
    if (hasActiveUrl(db, urlKey(patch.url), id)) {
      throw conflict(`URL 已被其他书签占用：${patch.url.trim()}`)
    }
  }

  const next = {
    title: patch.title ?? current.title,
    url: patch.url !== undefined ? patch.url.trim() : current.url,
    category: patch.category ?? current.category,
    note: patch.note ?? current.note,
  }
  db.prepare(
    'UPDATE bookmarks SET title = ?, url = ?, url_key = ?, category = ?, note = ?, updated_at = ? WHERE id = ?',
  ).run(next.title, next.url, urlKey(next.url), next.category, next.note, new Date().toISOString(), id)
  return getBookmark(db, id)
}

/** 软删除进回收站 */
export function softDeleteBookmark(db: Db, id: number): boolean {
  const now = new Date().toISOString()
  const result = db
    .prepare('UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now, now, id)
  return Number(result.changes) > 0
}

/** 从回收站恢复；URL 已被其他活跃书签占用时报冲突 */
export function restoreBookmark(db: Db, id: number): Bookmark | null {
  const current = getBookmark(db, id)
  if (!current || current.deletedAt === null) return null
  if (hasActiveUrl(db, urlKey(current.url), id)) {
    throw conflict(`恢复失败，URL 已被其他书签占用：${current.url}`)
  }
  db.prepare('UPDATE bookmarks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  )
  return getBookmark(db, id)
}

/** 彻底删除，仅限回收站内的行 */
export function purgeBookmark(db: Db, id: number): boolean {
  const result = db.prepare('DELETE FROM bookmarks WHERE id = ? AND deleted_at IS NOT NULL').run(id)
  return Number(result.changes) > 0
}

function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function batchSoftDelete(db: Db, ids: number[]): number {
  return tx(db, () => {
    const st = db.prepare(
      'UPDATE bookmarks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    )
    const now = new Date().toISOString()
    let n = 0
    for (const id of ids) n += Number(st.run(now, now, id).changes)
    return n
  })
}

/** 批量恢复：URL 冲突的行跳过不中断，返回实际恢复数 */
export function batchRestore(db: Db, ids: number[]): number {
  return tx(db, () => {
    let n = 0
    for (const id of ids) {
      const current = getBookmark(db, id)
      if (!current || current.deletedAt === null) continue
      if (hasActiveUrl(db, urlKey(current.url), id)) continue
      db.prepare('UPDATE bookmarks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        id,
      )
      n++
    }
    return n
  })
}

export function batchPurge(db: Db, ids: number[]): number {
  return tx(db, () => {
    const st = db.prepare('DELETE FROM bookmarks WHERE id = ? AND deleted_at IS NOT NULL')
    let n = 0
    for (const id of ids) n += Number(st.run(id).changes)
    return n
  })
}

export function batchRecategorize(db: Db, ids: number[], category: string): number {
  return tx(db, () => {
    const st = db.prepare('UPDATE bookmarks SET category = ?, updated_at = ? WHERE id = ?')
    const now = new Date().toISOString()
    let n = 0
    for (const id of ids) n += Number(st.run(category, now, id).changes)
    return n
  })
}

/** 分类下拉数据：活跃书签按分类计数，空分类（未分类）不列出 */
export function listCategories(db: Db): CategoryStat[] {
  return db
    .prepare(
      `SELECT category AS name, COUNT(*) AS count FROM bookmarks
       WHERE deleted_at IS NULL AND category <> ''
       GROUP BY category ORDER BY count DESC, name ASC`,
    )
    .all() as unknown as CategoryStat[]
}

/** 近似重复分组：忽略协议/www/查询参数/锚点，只提示不拦截 */
export function listDuplicateGroups(db: Db, maxGroups = 100, maxPerGroup = 50): DuplicateGroup[] {
  const rows = db
    .prepare(
      `SELECT ${BASE_COLUMNS} FROM bookmarks
       WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as BookmarkRow[]
  const groups = new Map<string, BookmarkRow[]>()
  for (const row of rows) {
    const key = duplicateKey(row.url)
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }
  return [...groups.entries()]
    .filter(([, g]) => g.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxGroups)
    .map(([key, g]) => ({ key, count: g.length, items: g.slice(0, maxPerGroup).map(toEntity) }))
}

/** 导入去重用：活跃书签的 url_key 全集 */
export function existingActiveUrlKeys(db: Db): Set<string> {
  const rows = db
    .prepare('SELECT url_key FROM bookmarks WHERE deleted_at IS NULL')
    .all() as unknown as Array<{ url_key: string }>
  return new Set(rows.map((r) => r.url_key))
}

export interface InsertRow {
  title: string
  url: string
  category: string
  note: string
  createdAt: string
  updatedAt: string
}

/** 导入批量插入：调用方（导入服务）已做过去重，这里不再查冲突 */
export function insertBookmarks(db: Db, rows: InsertRow[]): number {
  return tx(db, () => {
    const st = db.prepare(
      `INSERT INTO bookmarks (title, url, url_key, category, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    let n = 0
    for (const r of rows) {
      st.run(r.title, r.url, urlKey(r.url), r.category, r.note, r.createdAt, r.updatedAt)
      n++
    }
    return n
  })
}
