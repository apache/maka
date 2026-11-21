import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '@/server/bookmarks/db/database'
import { createBookmark, listBookmarks } from '@/server/bookmarks/db/repo-bookmarks'
import { previewImport, runImport } from '@/server/bookmarks/import-service'

const EXPORT_HTML = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3>书签栏</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000000">GitHub</A>
        <DT><A HREF="https://a.com/x?utm=1" ADD_DATE="1700000001">A 页面</A>
        <DT><A HREF="https://a.com/x/" ADD_DATE="1700000002">A 页面精确重复</A>
        <DT><A HREF="https://a.com/x" ADD_DATE="1700000003">A 页面批内重复</A>
    </DL><p>
</DL><p>`

function freshDb(): Db {
  return openDatabase(':memory:')
}

function listAll(db: Db) {
  return listBookmarks(db, { limit: 100, offset: 0 }).items
}

describe('导入服务', () => {
  it('预览：精确匹配去重（对库内与批内），分类计数返回，不落库', () => {
    const db = freshDb()
    // 库内已有一条 github（尾斜杠差异也算重复，Q7 定案）
    createBookmark(db, { title: 'GitHub 旧', url: 'https://github.com' })

    const preview = previewImport(db, EXPORT_HTML)
    expect(preview.totalParsed).toBe(4)
    expect(preview.willImport).toBe(2)
    expect(preview.skipped).toBe(2)
    // 四条书签都在书签栏顶层（结构层），分类为空
    expect(preview.categories).toEqual([])

    // 预览不落库
    expect(listAll(db)).toHaveLength(1)
    db.close()
  })

  it('确认：入库并保留 ADD_DATE 时间戳；重复导入同一份全部跳过', () => {
    const db = freshDb()
    // utm 变体与无参 URL 是不同 url_key（精确匹配），各算一条；第三条与其批内重复被跳过
    expect(runImport(db, EXPORT_HTML)).toEqual({ imported: 3, skipped: 1 })
    expect(runImport(db, EXPORT_HTML)).toEqual({ imported: 0, skipped: 4 })

    const list = listAll(db)
    expect(list).toHaveLength(3)
    const a = list.find((b) => b.url === 'https://a.com/x?utm=1')!
    expect(a.createdAt).toBe('2023-11-14T22:13:21.000Z')
    expect(a.category).toBe('')
    expect(a.note).toBe('')
    db.close()
  })

  it('非书签 HTML：解析为空，导入 0 条', () => {
    const db = freshDb()
    expect(previewImport(db, '<html><body><p>不是书签</p></body></html>')).toEqual({
      totalParsed: 0,
      willImport: 0,
      skipped: 0,
      categories: [],
    })
    expect(runImport(db, '<html></html>').imported).toBe(0)
    db.close()
  })
})
