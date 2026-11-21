import { z } from "zod";

// 迁移自 inbox/ggbdpq-site/schemas/content.ts，新增 source 字段标记 md 迁移来源

/** 作者信息 */
export const authorSchema = z.object({
  name: z.string(),
  slogan: z.string(),
  bio: z.string(),
  location: z.string(),
  avatarText: z.string(),
  badges: z.array(z.string()),
  stats: z.object({
    articles: z.number(),
    moments: z.number(),
    series: z.number(),
  }),
});
export type Author = z.infer<typeof authorSchema>;

/** 朋友圈动态 */
export const momentSchema = z.object({
  id: z.string(),
  date: z.iso.date(),
  content: z.string(),
  views: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  location: z.string().optional(),
  pinned: z.boolean().default(false),
});
export type Moment = z.infer<typeof momentSchema>;
/** 原始数据形态：pinned 可省略，解析时补默认值 */
export type MomentInput = z.input<typeof momentSchema>;

/** 技术文章（TS 内联与 md 文件双源共用） */
export const articleSchema = z.object({
  slug: z.string(),
  title: z.string(),
  series: z.string(),
  date: z.iso.date(),
  excerpt: z.string(),
  tags: z.array(z.string()),
  readingMinutes: z.number().int().positive(),
  views: z.number().int().nonnegative(),
  content: z.string(),
  /** md 迁移来源项目；TS 内联文章无此字段 */
  source: z.string().optional(),
});
export type Article = z.infer<typeof articleSchema>;
export type ArticleInput = z.input<typeof articleSchema>;

/** 系列 */
export const seriesSchema = z.object({
  name: z.string(),
  description: z.string(),
});
export type Series = z.infer<typeof seriesSchema>;

/** 成长记录 */
export const growthEntrySchema = z.object({
  id: z.string(),
  date: z.iso.date(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
});
export type GrowthEntry = z.infer<typeof growthEntrySchema>;
