import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// 书签域 API 契约测试：直接调用 Route Handler。
// connection 在取库路径时才读 CONSOLE_DATA_DIR，这里在动态 import 前指向一次性临时目录，避免碰真实 data/bookmarks.db。
const dataDir = mkdtempSync(join(tmpdir(), 'bookmarks-api-'))
process.env.CONSOLE_DATA_DIR = dataDir

type Ctx = { params: Promise<{ id: string }> }

const json = (body: unknown) =>
  new Request('http://localhost:3000/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

let collection: typeof import('@/app/api/bookmarks/bookmarks/route')
let item: typeof import('@/app/api/bookmarks/bookmarks/[id]/route')
let restoreRoute: typeof import('@/app/api/bookmarks/bookmarks/[id]/restore/route')
let importRoute: typeof import('@/app/api/bookmarks/import/route')
let duplicatesRoute: typeof import('@/app/api/bookmarks/duplicates/route')
let categoriesRoute: typeof import('@/app/api/bookmarks/categories/route')
let batchRoute: typeof import('@/app/api/bookmarks/batch/route')

beforeAll(async () => {
  collection = await import('@/app/api/bookmarks/bookmarks/route')
  item = await import('@/app/api/bookmarks/bookmarks/[id]/route')
  restoreRoute = await import('@/app/api/bookmarks/bookmarks/[id]/restore/route')
  importRoute = await import('@/app/api/bookmarks/import/route')
  duplicatesRoute = await import('@/app/api/bookmarks/duplicates/route')
  categoriesRoute = await import('@/app/api/bookmarks/categories/route')
  batchRoute = await import('@/app/api/bookmarks/batch/route')
})

afterAll(async () => {
  // 关闭连接再清理临时目录（Windows 下打开中的 sqlite 文件删不掉）
  const { getBookmarkDb } = await import('@/server/bookmarks/connection')
  try {
    getBookmarkDb().close()
  } catch {
    // 已关闭
  }
  rmSync(dataDir, { recursive: true, force: true })
})

describe('书签域 API 契约', () => {
  it('POST 创建 201；同 URL（尾斜杠差异）409 CONFLICT', async () => {
    const created = await collection.POST(json({ title: 'GitHub', url: 'https://github.com/' }))
    expect(created.status).toBe(201)
    const dup = await collection.POST(json({ title: 'GitHub 复制', url: 'https://github.com' }))
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { code: string }).code).toBe('CONFLICT')

    const bad = await collection.POST(json({ title: '坏', url: '不是URL' }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { code: string }).code).toBe('VALIDATION_ERROR')
  })

  it('GET 列表：q/category/view 过滤与分页结构', async () => {
    const res = await collection.GET(
      new Request('http://localhost:3000/api/bookmarks/bookmarks?limit=1&offset=0'),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; limit: number; offset: number }
    expect(body.total).toBe(1)
    expect(body.limit).toBe(1)

    const filtered = await collection.GET(
      new Request('http://localhost:3000/api/bookmarks/bookmarks?q=github'),
    )
    expect(((await filtered.json()) as { total: number }).total).toBe(1)
  })

  it('PATCH 更新；非法 body 400', async () => {
    const list = (await (
      await collection.GET(new Request('http://localhost:3000/api/bookmarks/bookmarks'))
    ).json()) as { items: Array<{ id: number }> }
    const id = list.items[0].id

    const ok = await item.PATCH(json({ category: '开发', note: '主仓' }), {
      params: Promise.resolve({ id: String(id) }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { category: string; note: string }
    expect(body.category).toBe('开发')

    const bad = await item.PATCH(json({}), { params: Promise.resolve({ id: String(id) }) })
    expect(bad.status).toBe(400)

    const missing = await item.PATCH(json({ title: 'x' }), { params: Promise.resolve({ id: '999' }) })
    expect(missing.status).toBe(404)
  })

  it('DELETE 软删 → 回收站可见 → 活跃行拒绝 purge → purge 彻底删 → restore 404', async () => {
    const created = await collection.POST(json({ title: '待删链', url: 'https://del.example.com' }))
    const { id } = (await created.json()) as { id: number }
    const ctx = { params: Promise.resolve({ id: String(id) }) }

    expect((await item.DELETE(new Request('http://localhost:3000/x'), ctx)).status).toBe(204)
    const trash = (await (
      await collection.GET(new Request('http://localhost:3000/api/bookmarks/bookmarks?view=trash'))
    ).json()) as { total: number }
    expect(trash.total).toBe(1)

    // 活跃行不能直接 purge
    const created2 = await collection.POST(json({ title: '活跃', url: 'https://live.example.com' }))
    const { id: id2 } = (await created2.json()) as { id: number }
    const purgeActive = await item.DELETE(
      new Request('http://localhost:3000/x?purge=true'),
      { params: Promise.resolve({ id: String(id2) }) },
    )
    expect(purgeActive.status).toBe(409)

    const restored = await restoreRoute.POST(new Request('http://localhost:3000/x'), ctx)
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as { deletedAt: string | null }).deletedAt).toBeNull()

    await item.DELETE(new Request('http://localhost:3000/x'), ctx)
    const purged = await item.DELETE(new Request('http://localhost:3000/x?purge=true'), ctx)
    expect(purged.status).toBe(204)
    expect((await restoreRoute.POST(new Request('http://localhost:3000/x'), ctx)).status).toBe(404)
  })

  it('导入：preview 不落库、confirm 入库、缺字段 400', async () => {
    const preview = await importRoute.POST(
      json({ confirm: false, html: '<DL><p><DT><A HREF="https://imported.example/">导入</A></DL><p>' }),
    )
    expect(preview.status).toBe(200)
    expect((await preview.json()) as { willImport: number }).toEqual({
      totalParsed: 1,
      willImport: 1,
      skipped: 0,
      categories: [],
    })

    const before = (await (
      await collection.GET(new Request('http://localhost:3000/api/bookmarks/bookmarks'))
    ).json()) as { total: number }
    // 前序用例留下了 GitHub 与 live.example.com 两条活跃书签
    expect(before.total).toBe(2)

    const confirmed = await importRoute.POST(
      json({ confirm: true, html: '<DL><p><DT><A HREF="https://imported.example/">导入</A></DL><p>' }),
    )
    expect((await confirmed.json()) as { imported: number }).toEqual({ imported: 1, skipped: 0 })

    const bad = await importRoute.POST(json({ confirm: false }))
    expect(bad.status).toBe(400)
  })

  it('重复检测分组 + 分类统计', async () => {
    await collection.POST(json({ title: '近似重复', url: 'http://www.github.com/' }))
    const dup = (await (await duplicatesRoute.GET()).json()) as {
      groups: Array<{ key: string; count: number }>
    }
    expect(dup.groups.length).toBeGreaterThanOrEqual(1)
    expect(dup.groups.some((g) => g.key === 'github.com/' && g.count >= 2)).toBe(true)

    const cats = (await (await categoriesRoute.GET()).json()) as {
      categories: Array<{ name: string; count: number }>
    }
    expect(cats.categories.some((c) => c.name === '开发' && c.count >= 1)).toBe(true)
  })

  it('批量：删除/恢复/改分类，返回受影响行数；校验失败 400', async () => {
    const list = (await (
      await collection.GET(new Request('http://localhost:3000/api/bookmarks/bookmarks'))
    ).json()) as { items: Array<{ id: number }> }
    const ids = list.items.map((i) => i.id)

    const del = await batchRoute.POST(json({ action: 'delete', ids }))
    expect(((await del.json()) as { affected: number }).affected).toBe(ids.length)

    const restore = await batchRoute.POST(json({ action: 'restore', ids }))
    expect(((await restore.json()) as { affected: number }).affected).toBe(ids.length)

    const recat = await batchRoute.POST(json({ action: 'recategorize', ids, category: '批量分类' }))
    expect(((await recat.json()) as { affected: number }).affected).toBe(ids.length)

    const bad = await batchRoute.POST(json({ action: 'recategorize', ids }))
    expect(bad.status).toBe(400)
  })
})
