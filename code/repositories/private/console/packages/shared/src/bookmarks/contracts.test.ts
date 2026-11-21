import { describe, expect, it } from 'vitest'
import {
  BatchRequestSchema,
  BookmarkSchema,
  CreateBookmarkInputSchema,
  DuplicatesResponseSchema,
  ErrorEnvelopeSchema,
  ImportPreviewSchema,
  UpdateBookmarkInputSchema,
} from './index'

const validBookmark = {
  id: 1,
  title: 'GitHub',
  url: 'https://github.com',
  category: '开发',
  note: '',
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
  deletedAt: null,
}

describe('bookmark schemas', () => {
  it('接受合法书签，拒绝非法时间戳与负数 id', () => {
    expect(BookmarkSchema.parse(validBookmark)).toBeTruthy()
    expect(BookmarkSchema.safeParse({ ...validBookmark, createdAt: '昨天' }).success).toBe(false)
    expect(BookmarkSchema.safeParse({ ...validBookmark, id: 1.5 }).success).toBe(false)
    expect(BookmarkSchema.parse({ ...validBookmark, deletedAt: '2026-09-13T01:00:00.000Z' })).toBeTruthy()
  })

  it('新增输入：url 必须是合法 URL，title 必填非空', () => {
    expect(CreateBookmarkInputSchema.safeParse({ title: 'x', url: '不是URL' }).success).toBe(false)
    expect(CreateBookmarkInputSchema.safeParse({ title: '', url: 'https://a.com' }).success).toBe(false)
    expect(CreateBookmarkInputSchema.parse({ title: 'x', url: 'https://a.com' })).toBeTruthy()
  })

  it('修改输入：空 patch 被拒绝，非空 patch 通过', () => {
    expect(UpdateBookmarkInputSchema.safeParse({}).success).toBe(false)
    expect(UpdateBookmarkInputSchema.parse({ category: '' })).toBeTruthy()
  })

  it('批量请求：recategorize 必须带 category，其余动作不需要', () => {
    expect(BatchRequestSchema.safeParse({ action: 'recategorize', ids: [1] }).success).toBe(false)
    expect(BatchRequestSchema.parse({ action: 'recategorize', ids: [1], category: '新分类' })).toBeTruthy()
    expect(BatchRequestSchema.parse({ action: 'delete', ids: [1, 2] })).toBeTruthy()
    expect(BatchRequestSchema.safeParse({ action: 'delete', ids: [] }).success).toBe(false)
  })

  it('导入预览与重复分组形态可解析', () => {
    expect(
      ImportPreviewSchema.parse({ totalParsed: 10, willImport: 8, skipped: 2, categories: [{ name: '奶酪书签', count: 5 }] }),
    ).toBeTruthy()
    expect(DuplicatesResponseSchema.parse({ groups: [{ key: 'a.com/x', count: 2, items: [validBookmark] }] })).toBeTruthy()
  })

  it('错误封套拒绝未知错误码', () => {
    expect(ErrorEnvelopeSchema.parse({ code: 'CONFLICT', message: 'x' })).toBeTruthy()
    expect(ErrorEnvelopeSchema.safeParse({ code: 'WOOPS', message: 'x' }).success).toBe(false)
  })
})
