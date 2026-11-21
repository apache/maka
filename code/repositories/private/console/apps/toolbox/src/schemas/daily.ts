import { z } from "zod"

export const sourceKindSchema = z.enum(["aihot", "official"])

export const newsSourceSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().optional(),
  kind: sourceKindSchema,
})

export const newsItemSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  titleEn: z.string().trim().min(1).nullable().optional(),
  summary: z.string().trim().min(1).nullable().optional(),
  url: z.string().min(1),
  category: z.string().trim().min(1),
  score: z.number().int().nullable().optional(),
  selected: z.boolean().default(false),
  publishedAt: z.string().nullable().optional(),
  sources: z.array(newsSourceSchema).min(1),
  aiSummary: z.string().trim().min(1).nullable().optional(),
})

export const dailySectionSchema = z.object({
  label: z.string().trim().min(1),
  items: z.array(newsItemSchema),
})

export const dailyStatsSchema = z.object({
  itemCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
})

export const dailyLeadSchema = z
  .object({
    title: z.string().trim().min(1),
    paragraph: z.string().trim().min(1).nullable().optional(),
  })
  .nullable()
  .optional()

export const dailyReportSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string(),
  windowStart: z.string().nullable().optional(),
  windowEnd: z.string().nullable().optional(),
  lead: dailyLeadSchema,
  sections: z.array(dailySectionSchema),
  stats: dailyStatsSchema,
})

export const archiveRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string(),
  leadTitle: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  selectedCount: z.number().int().nonnegative(),
})

export const sourceHealthSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().min(1),
  status: z.enum(["success", "error", "disabled"]),
  checkedAt: z.string(),
  itemCount: z.number().int().nonnegative(),
  message: z.string().nullable(),
})

export const topItemInsightSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  score: z.number().int().nonnegative(),
  reason: z.string().trim().min(1),
})

export const themeInsightSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  keywords: z.array(z.string().trim().min(1)),
  itemIds: z.array(z.string().trim().min(1)),
})

export const trendInsightSchema = z.object({
  label: z.string().trim().min(1),
  count: z.number().int().nonnegative(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
})

export const dailyInsightsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  topItems: z.array(topItemInsightSchema),
  themes: z.array(themeInsightSchema),
  trends: z.array(trendInsightSchema),
})

export const sourceConfigSchema = z.object({
  name: z.string().trim().min(1),
  url: z.string().min(1),
  kind: z.enum(["rss", "html"]),
  category: z.string().trim().min(1),
  enabled: z.boolean().default(true),
  weight: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive().default(10_000),
  retryCount: z.number().int().nonnegative().default(1),
})

export type NewsSource = z.infer<typeof newsSourceSchema>
export type NewsItem = z.infer<typeof newsItemSchema>
export type DailyReport = z.infer<typeof dailyReportSchema>
export type ArchiveRow = z.infer<typeof archiveRowSchema>
export type SourceHealth = z.infer<typeof sourceHealthSchema>
export type DailyInsights = z.infer<typeof dailyInsightsSchema>
export type SourceConfig = z.infer<typeof sourceConfigSchema>
