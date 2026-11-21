import { z } from "zod"

/** 联系方式中的一条链接（GitHub / 博客 / 作品集…） */
export const linkSchema = z.object({
  id: z.string(),
  label: z.string().min(1, "链接名称不能为空"),
  url: z.string().min(1, "链接地址不能为空"),
})

/** 基本信息 */
export const profileSchema = z.object({
  name: z.string().min(1, "姓名不能为空"),
  headline: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default(""),
  location: z.string().default(""),
  website: z.string().default(""),
  avatar: z.string().default(""),
  links: z.array(linkSchema).default([]),
})

/** 工作经历 / 项目经历 / 教育经历共用的条目结构 */
export const entrySchema = z.object({
  id: z.string(),
  title: z.string().min(1, "标题不能为空"),
  subtitle: z.string().default(""),
  /** 灰底小标签（如「驻场」「全职」），可选 */
  badge: z.string().optional(),
  location: z.string().default(""),
  startDate: z.string().default(""),
  endDate: z.string().default(""),
  /** Markdown 正文，支持无序列表与加粗 */
  body: z.string().default(""),
})

/** 技能组 */
export const skillGroupSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "技能组名称不能为空"),
  keywords: z.array(z.string()).default([]),
})

/** 自定义模块 */
export const customSectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1, "模块名称不能为空"),
  body: z.string().default(""),
})

export const sectionKeySchema = z.enum([
  "summary",
  "work",
  "projects",
  "education",
  "skills",
  "custom",
])

export type SectionKey = z.infer<typeof sectionKeySchema>

/** 简历主体数据 */
export const resumeSchema = z.object({
  profile: profileSchema,
  summary: z.string().default(""),
  work: z.array(entrySchema).default([]),
  projects: z.array(entrySchema).default([]),
  education: z.array(entrySchema).default([]),
  skills: z.array(skillGroupSchema).default([]),
  custom: z.array(customSectionSchema).default([]),
  /** 模块展示顺序与显隐 */
  sectionOrder: z.array(sectionKeySchema).default([
    "summary",
    "work",
    "projects",
    "education",
    "skills",
  ]),
  hiddenSections: z.array(sectionKeySchema).default([]),
})

export type Link = z.infer<typeof linkSchema>
export type Profile = z.infer<typeof profileSchema>
export type Entry = z.infer<typeof entrySchema>
export type SkillGroup = z.infer<typeof skillGroupSchema>
export type CustomSection = z.infer<typeof customSectionSchema>
export type Resume = z.infer<typeof resumeSchema>

/** 简历外观设置 */
export const appearanceSchema = z.object({
  themeId: z.string().default("graphite"),
  /** 紧凑档校准（对齐木及密度）：12.5px / 1.5 / 48 */
  fontSize: z.number().min(11).max(18).default(12.5),
  lineHeight: z.number().min(1.2).max(2).default(1.5),
  pagePadding: z.number().min(24).max(72).default(48),
  /** 姓名与头衔同行（木及式「姓名 - 头衔」大标题） */
  nameInline: z.boolean().default(true),
  /** 覆盖主题强调色（木及「可换色」），空则跟随主题 */
  accentOverride: z.string().optional(),
  /** 纸面字体族：sans 无衬线 / serif 衬线 */
  fontFamily: z.enum(["sans", "serif"]).default("sans"),
  /** 证件照圆形 */
  avatarRound: z.boolean().default(false),
  /** 智能一页：自动缩放内容以放进一页 A4 */
  fitToOnePage: z.boolean().default(true),
  showAvatar: z.boolean().default(true),
})

export type Appearance = z.infer<typeof appearanceSchema>

export const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const createEmptyEntry = (): Entry => ({
  id: uid(),
  title: "",
  subtitle: "",
  location: "",
  startDate: "",
  endDate: "",
  body: "",
})
