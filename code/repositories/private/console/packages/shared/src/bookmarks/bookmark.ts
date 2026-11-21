import { z } from 'zod'

/** ISO 8601 UTC 时间戳（SQLite TEXT 列的契约形态，与 todo 域同构） */
export const IsoDateTimeSchema = z.iso.datetime()

/** 书签实体（API 返回形态） */
export const BookmarkSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string(),
  category: z.string(),
  note: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
})
export type Bookmark = z.infer<typeof BookmarkSchema>

/** 新增书签输入 */
export const CreateBookmarkInputSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.url().max(2048),
  category: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
})
export type CreateBookmarkInput = z.infer<typeof CreateBookmarkInputSchema>

/** 修改书签输入：全部字段可选，但至少给一个 */
export const UpdateBookmarkInputSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    url: z.url().max(2048).optional(),
    category: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一个要修改的字段' })
export type UpdateBookmarkInput = z.infer<typeof UpdateBookmarkInputSchema>

/** 列表视图：active 主列表 / trash 回收站 */
export const BookmarkViewSchema = z.enum(['active', 'trash'])
export type BookmarkView = z.infer<typeof BookmarkViewSchema>

/** 分页列表响应（服务端过滤 + 分页，5693+ 条量级不全量渲染） */
export const BookmarkListResponseSchema = z.object({
  items: z.array(BookmarkSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
})
export type BookmarkListResponse = z.infer<typeof BookmarkListResponseSchema>

/** 分类统计（名称 + 活跃书签计数） */
export const CategoryStatSchema = z.object({ name: z.string(), count: z.number().int() })
export type CategoryStat = z.infer<typeof CategoryStatSchema>

/** 导入请求：confirm=false 返回预览摘要，confirm=true 才真正入库 */
export const ImportRequestSchema = z.object({
  html: z.string().min(1).max(20_000_000),
  confirm: z.boolean(),
})
export type ImportRequest = z.infer<typeof ImportRequestSchema>

export const ImportPreviewSchema = z.object({
  totalParsed: z.number().int(),
  willImport: z.number().int(),
  skipped: z.number().int(),
  categories: z.array(CategoryStatSchema).max(200),
})
export type ImportPreview = z.infer<typeof ImportPreviewSchema>

export const ImportResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int(),
})
export type ImportResult = z.infer<typeof ImportResultSchema>

/** 批量操作 */
export const BatchActionSchema = z.enum(['delete', 'restore', 'purge', 'recategorize'])
export type BatchAction = z.infer<typeof BatchActionSchema>

export const BatchRequestSchema = z
  .object({
    action: BatchActionSchema,
    ids: z.array(z.number().int().positive()).min(1).max(10000),
    category: z.string().max(200).optional(),
  })
  .refine((v) => v.action !== 'recategorize' || v.category !== undefined, {
    message: 'recategorize 必须提供 category',
  })
export type BatchRequest = z.infer<typeof BatchRequestSchema>

export const BatchResultSchema = z.object({ affected: z.number().int() })
export type BatchResult = z.infer<typeof BatchResultSchema>

/** 近似重复分组（键忽略协议/www/查询参数/锚点） */
export const DuplicateGroupSchema = z.object({
  key: z.string(),
  count: z.number().int(),
  items: z.array(BookmarkSchema),
})
export type DuplicateGroup = z.infer<typeof DuplicateGroupSchema>

export const DuplicatesResponseSchema = z.object({ groups: z.array(DuplicateGroupSchema) })
export type DuplicatesResponse = z.infer<typeof DuplicatesResponseSchema>
