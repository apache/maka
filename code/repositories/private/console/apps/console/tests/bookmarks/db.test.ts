import { describe, expect, it } from 'vitest'
import { openDatabase } from '@/server/bookmarks/db/database'
import {
  batchPurge,
  batchRecategorize,
  batchRestore,
  batchSoftDelete,
  createBookmark,
  existingActiveUrlKeys,
  getBookmark,
  insertBookmarks,
  listBookmarks,
  listCategories,
  listDuplicateGroups,
  purgeBookmark,
  restoreBookmark,
  softDeleteBookmark,
  updateBookmark,
} from '@/server/bookmarks/db/repo-bookmarks'

/** 每个用例独立 :memory: 库，天然隔离（node:sqlite 每连接独立内存库） */
function freshDb() {
  return openDatabase(':memory:')
}

describe('迁移', () => {
  it('建库后 schema_migrations 记录到版本 1', () => {
    const db = freshDb()
    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as unknown as Array<{ version: number }>
    expect(rows).toEqual([{ version: 1 }])
    db.close()
  })
})

describe('bookmarks CRUD', () => {
  it('创建回填 url_key 与默认值，列表按 created_at 倒序', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'GitHub', url: 'https://github.com/' })
    const b = createBookmark(db, {
      title: '文档',
      url: 'https://docs.example.com',
      category: '开发',
      note: '好用的文档',
    })

    expect(a.category).toBe('')
    expect(a.note).toBe('')
    expect(a.deletedAt).toBeNull()
    expect(b.category).toBe('开发')

    expect(listBookmarks(db, { limit: 10, offset: 0 }).items.map((x) => x.title)).toEqual([
      '文档',
      'GitHub',
    ])
    db.close()
  })

  it('活跃 URL 唯一：同 URL（含尾斜杠差异）创建报冲突，大小写敏感', () => {
    const db = freshDb()
    createBookmark(db, { title: 'A', url: 'https://a.com/x' })
    expect(() => createBookmark(db, { title: 'B', url: 'https://a.com/x' })).toThrow('已存在相同 URL')
    expect(() => createBookmark(db, { title: 'B', url: 'https://a.com/x/' })).toThrow()
    // 协议不同不算同一条（Q7 定案：精确匹配）
    expect(() => createBookmark(db, { title: 'C', url: 'http://a.com/x' })).not.toThrow()
    db.close()
  })

  it('update 改 URL 重算 url_key，与其他活跃书签冲突时报 409', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'A', url: 'https://a.com/1' })
    createBookmark(db, { title: 'B', url: 'https://b.com/' })
    expect(() => updateBookmark(db, a.id, { url: 'https://b.com' })).toThrow()
    const updated = updateBookmark(db, a.id, { url: 'https://c.com/', title: 'A2' })!
    expect(updated.url).toBe('https://c.com/')
    expect(updated.title).toBe('A2')
    db.close()
  })

  it('软删→回收站视图可见→恢复→彻底删除 全链', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: '待删', url: 'https://a.com/' })

    expect(softDeleteBookmark(db, a.id)).toBe(true)
    expect(listBookmarks(db, { limit: 10, offset: 0 }).total).toBe(0)
    const trash = listBookmarks(db, { view: 'trash', limit: 10, offset: 0 })
    expect(trash.total).toBe(1)
    expect(getBookmark(db, a.id)!.deletedAt).toBeTruthy()

    const restored = restoreBookmark(db, a.id)!
    expect(restored.deletedAt).toBeNull()
    expect(listBookmarks(db, { limit: 10, offset: 0 }).total).toBe(1)

    // 已恢复（非回收站）的行不能直接 purge
    expect(purgeBookmark(db, a.id)).toBe(false)
    softDeleteBookmark(db, a.id)
    expect(purgeBookmark(db, a.id)).toBe(true)
    expect(getBookmark(db, a.id)).toBeNull()
    db.close()
  })

  it('恢复时 URL 已被其他活跃书签占用报冲突', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'A', url: 'https://a.com/' })
    softDeleteBookmark(db, a.id)
    createBookmark(db, { title: 'B', url: 'https://a.com' })
    expect(() => restoreBookmark(db, a.id)).toThrow()
    db.close()
  })

  it('update/软删不存在的 id 返回 null/false', () => {
    const db = freshDb()
    expect(updateBookmark(db, 999, { title: 'x' })).toBeNull()
    expect(softDeleteBookmark(db, 999)).toBe(false)
    db.close()
  })
})

describe('过滤与分页', () => {
  function seed() {
    const db = freshDb()
    createBookmark(db, { title: 'GitHub 仓库', url: 'https://github.com/a', category: '开发' })
    createBookmark(db, { title: 'GamsGo 面板', url: 'https://gamsgo.com', category: '开发' })
    createBookmark(db, { title: '公众号', url: 'https://mp.weixin.qq.com', category: '阅读', note: '评分10%' })
    createBookmark(db, { title: '编码页', url: 'https://e.com/a%20b', category: '工具' })
    return db
  }

  it('q 关键词匹配标题/URL/分类，LIKE 通配符按字面搜索', () => {
    const db = seed()
    expect(listBookmarks(db, { q: 'github', limit: 10, offset: 0 }).total).toBe(1)
    expect(listBookmarks(db, { q: 'weixin', limit: 10, offset: 0 }).total).toBe(1)
    expect(listBookmarks(db, { q: '开发', limit: 10, offset: 0 }).total).toBe(2)
    // URL 里的 % 编码按字面匹配，不当通配符
    expect(listBookmarks(db, { q: 'a%20', limit: 10, offset: 0 }).total).toBe(1)
    // _ 同理按字面：'a_20' 作为通配符本可命中 a%20b，转义后命中 0
    expect(listBookmarks(db, { q: 'a_20', limit: 10, offset: 0 }).total).toBe(0)
    db.close()
  })

  it('category 精确过滤 + limit/offset 分页 + total 是全量计数', () => {
    const db = seed()
    expect(listBookmarks(db, { category: '开发', limit: 10, offset: 0 }).total).toBe(2)
    const page = listBookmarks(db, { limit: 2, offset: 2 })
    expect(page.total).toBe(4)
    expect(page.items).toHaveLength(2)
    db.close()
  })

  it('listCategories 排除空分类并按计数倒序', () => {
    const db = seed()
    expect(listCategories(db)).toEqual([
      { name: '开发', count: 2 },
      { name: '工具', count: 1 },
      { name: '阅读', count: 1 },
    ])
    db.close()
  })
})

describe('批量操作', () => {
  it('批量软删/恢复/彻底删除/改分类', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'A', url: 'https://a.com/' })
    const b = createBookmark(db, { title: 'B', url: 'https://b.com/' })
    const c = createBookmark(db, { title: 'C', url: 'https://c.com/' })

    expect(batchSoftDelete(db, [a.id, b.id])).toBe(2)
    expect(listBookmarks(db, { limit: 10, offset: 0 }).total).toBe(1)

    // a 的 URL 已被 c 占用？不——c 是 https://c.com，a 恢复无冲突；b 也无冲突
    expect(batchRestore(db, [a.id, b.id])).toBe(2)
    expect(batchRecategorize(db, [a.id, b.id, c.id], '统一')).toBe(3)
    expect(listCategories(db)).toEqual([{ name: '统一', count: 3 }])

    batchSoftDelete(db, [a.id, b.id])
    expect(batchPurge(db, [a.id, b.id, 999])).toBe(2)
    expect(listBookmarks(db, { view: 'trash', limit: 10, offset: 0 }).total).toBe(0)
    db.close()
  })

  it('批量恢复跳过 URL 冲突行，不中断', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'A', url: 'https://a.com/' })
    softDeleteBookmark(db, a.id)
    createBookmark(db, { title: '占位', url: 'https://a.com' })
    expect(batchRestore(db, [a.id])).toBe(0)
    expect(listBookmarks(db, { view: 'trash', limit: 10, offset: 0 }).total).toBe(1)
    db.close()
  })
})

describe('重复检测与导入辅助', () => {
  it('近似重复分组：协议/www/参数差异归同组，url 精确唯一不拦截共存', () => {
    const db = freshDb()
    createBookmark(db, { title: 'A1', url: 'https://a.com/x?utm=1' })
    createBookmark(db, { title: 'A2', url: 'http://www.a.com/x/' })
    createBookmark(db, { title: 'B', url: 'https://b.com/' })

    const groups = listDuplicateGroups(db)
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
    expect(groups[0].key).toBe('a.com/x')
    db.close()
  })

  it('existingActiveUrlKeys 只含活跃行，回收站不占用', () => {
    const db = freshDb()
    const a = createBookmark(db, { title: 'A', url: 'https://a.com/' })
    expect(existingActiveUrlKeys(db)).toEqual(new Set(['https://a.com']))
    softDeleteBookmark(db, a.id)
    expect(existingActiveUrlKeys(db).size).toBe(0)
    db.close()
  })

  it('insertBookmarks 批量插入跳过冲突检查（导入服务负责去重）', () => {
    const db = freshDb()
    const now = new Date().toISOString()
    const n = insertBookmarks(db, [
      { title: 'A', url: 'https://a.com/', category: 'x', note: '', createdAt: now, updatedAt: now },
      { title: 'B', url: 'https://b.com/', category: 'x', note: '', createdAt: now, updatedAt: now },
    ])
    expect(n).toBe(2)
    expect(listBookmarks(db, { limit: 10, offset: 0 }).total).toBe(2)
    db.close()
  })
})
