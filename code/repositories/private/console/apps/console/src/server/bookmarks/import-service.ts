import type { ImportPreview } from '@ggbdpq/console-shared/bookmarks'
import type { Db } from './db/database'
import { existingActiveUrlKeys, insertBookmarks } from './db/repo-bookmarks'
import { parseNetscapeBookmarks } from './netscape'
import { urlKey } from './url-key'

interface ResolvedImport {
  rows: Array<{
    title: string
    url: string
    category: string
    note: string
    createdAt: string
    updatedAt: string
  }>
  totalParsed: number
  skipped: number
  categories: Map<string, number>
}

/** 解析 + 去重（对库内活跃书签与批内自重），预览与入库共用同一份结果保证两段式一致 */
function resolveImport(db: Db, html: string): ResolvedImport {
  const parsed = parseNetscapeBookmarks(html)
  const existing = existingActiveUrlKeys(db)
  const seen = new Set<string>()
  const rows: ResolvedImport['rows'] = []
  const categories = new Map<string, number>()
  let skipped = 0
  for (const p of parsed) {
    const key = urlKey(p.url)
    if (existing.has(key) || seen.has(key)) {
      skipped++
      continue
    }
    seen.add(key)
    const createdAt = p.addedAt ?? new Date().toISOString()
    rows.push({
      title: p.title,
      url: p.url,
      category: p.category,
      note: '',
      createdAt,
      updatedAt: createdAt,
    })
    if (p.category) categories.set(p.category, (categories.get(p.category) ?? 0) + 1)
  }
  return { rows, totalParsed: parsed.length, skipped, categories }
}

export function previewImport(db: Db, html: string): ImportPreview {
  const r = resolveImport(db, html)
  return {
    totalParsed: r.totalParsed,
    willImport: r.rows.length,
    skipped: r.skipped,
    categories: [...r.categories.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 200),
  }
}

export function runImport(db: Db, html: string): { imported: number; skipped: number } {
  const r = resolveImport(db, html)
  if (r.rows.length > 0) insertBookmarks(db, r.rows)
  return { imported: r.rows.length, skipped: r.skipped }
}
