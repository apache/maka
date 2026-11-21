import { z } from 'zod'

// 实践台（/practice）：个人 git 开发实践的可视化与复盘。
// 命名统一加 Practice 前缀（走主入口导出，避免与既有域同名冲突）。

export const PRACTICE_TYPES = ['pr', 'issue', 'other'] as const
export type PracticeType = (typeof PRACTICE_TYPES)[number]

/** 新增功能视作 PR，缺陷修复视作 Issue，其余（重构/文档/杂项）归 other */
export const PRACTICE_TYPE_LABELS: Record<PracticeType, string> = {
  pr: '功能新增',
  issue: '缺陷修复',
  other: '其他改动',
}

export const PracticeWindowSchema = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type PracticeWindow = z.infer<typeof PracticeWindowSchema>

export const PracticeFileChangeSchema = z.object({
  path: z.string(),
  insertions: z.number(),
  deletions: z.number(),
})
export type PracticeFileChange = z.infer<typeof PracticeFileChangeSchema>

export const PracticeCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  repo: z.string(),
  branches: z.array(z.string()),
  /** 清理 AI 围栏残留后的提交标题 */
  subject: z.string(),
  /** git 原始标题（详情对照用） */
  rawSubject: z.string(),
  type: z.enum(PRACTICE_TYPES),
  authorName: z.string(),
  authorEmail: z.string(),
  /** ISO 8601（作者时间） */
  authoredAt: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  filesChanged: z.number(),
  /** TAPD bug 单号（subject 内 --bug=N@tapd 形式） */
  tapdBug: z.string().nullable(),
  files: z.array(PracticeFileChangeSchema),
})
export type PracticeCommit = z.infer<typeof PracticeCommitSchema>

export const PracticeRepoSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  commits: z.number(),
  /** 同步该仓库时的错误（仓库缺失/非 git 目录等）；null = 成功 */
  error: z.string().nullable(),
})
export type PracticeRepoSummary = z.infer<typeof PracticeRepoSummarySchema>

export const PracticeTypeCountSchema = z.object({
  pr: z.number(),
  issue: z.number(),
  other: z.number(),
})
export type PracticeTypeCount = z.infer<typeof PracticeTypeCountSchema>

export const PracticeClusterSchema = z.object({
  key: z.string(),
  count: z.number(),
  /** 该聚类中最新的几条提交标题样本 */
  samples: z.array(z.string()),
})
export type PracticeCluster = z.infer<typeof PracticeClusterSchema>

export const PracticeStatsSchema = z.object({
  total: z.number(),
  byType: PracticeTypeCountSchema,
  byRepo: z.array(
    z.object({
      repo: z.string(),
      total: z.number(),
      byType: PracticeTypeCountSchema,
    }),
  ),
  /** 按自然周（周一为起点）聚合的活动量 */
  weekly: z.array(
    z.object({
      weekStart: z.string(),
      total: z.number(),
      pr: z.number(),
      issue: z.number(),
      other: z.number(),
    }),
  ),
  /** 修复类提交的 scope 聚类（fix(scope): 中的 scope） */
  topFixScopes: z.array(PracticeClusterSchema),
  /** 修复类提交触及的目录聚类（文件路径 dirname 归并） */
  topFixDirs: z.array(PracticeClusterSchema),
  /** 反复修改的文件（按完整路径聚类） */
  topFixFiles: z.array(PracticeClusterSchema),
})
export type PracticeStats = z.infer<typeof PracticeStatsSchema>

/** GET /api/practice/data 全量载荷 */
export const PracticeDataSchema = z.object({
  syncedAt: z.string().nullable(),
  window: PracticeWindowSchema,
  authors: z.array(z.string()),
  repos: z.array(PracticeRepoSummarySchema),
  /** 当前窗口内出现过提交的分支（去重后） */
  branches: z.array(z.string()),
  commits: z.array(PracticeCommitSchema),
  stats: PracticeStatsSchema,
})
export type PracticeData = z.infer<typeof PracticeDataSchema>

/** POST /api/practice/sync 请求 */
export const PracticeSyncRequestSchema = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})
export type PracticeSyncRequest = z.infer<typeof PracticeSyncRequestSchema>

/** POST /api/practice/sync 响应 */
export const PracticeSyncResponseSchema = z.object({
  ok: z.boolean(),
  commits: z.number(),
  durationMs: z.number(),
  perRepo: z.array(PracticeRepoSummarySchema),
})
export type PracticeSyncResponse = z.infer<typeof PracticeSyncResponseSchema>

/** POST /api/practice/chat 请求 */
export const PracticeChatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
})
export type PracticeChatRequest = z.infer<typeof PracticeChatRequestSchema>

/** chat SSE 事件（无工具回路，纯解读型对话） */
export const PracticeSseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
export type PracticeSseEvent = z.infer<typeof PracticeSseEventSchema>
