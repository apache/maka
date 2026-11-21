import {
  appearanceSchema,
  resumeSchema,
  uid,
  type Appearance,
  type Resume,
} from "@/features/resume/lib/resume-schema"
import { sampleResume } from "@/features/resume/lib/sample-resume"

/** 一份简历文档（内容 + 外观），多简历集合的基本单位 */
export interface ResumeSnapshot {
  id: string
  at: number
  label: string
  resume: Resume
  appearance: Appearance
}

export interface ResumeDoc {
  id: string
  name: string
  resume: Resume
  appearance: Appearance
  updatedAt: number
  /** 历史快照（新→旧，最多 20 条） */
  history?: ResumeSnapshot[]
}

const defaultAppearance = () => appearanceSchema.parse({})

/**
 * 快照入栈：手动快照（带 label）必入栈；自动快照 30 秒内合并防打爆；
 * 上限 20 条，resume 深拷贝防后续编辑污染。
 */
export function pushHistory(doc: ResumeDoc, label?: string): ResumeDoc {
  const history = doc.history ?? []
  const last = history[0]
  if (!label && last && Date.now() - last.at < 30_000) return doc
  const snap: ResumeSnapshot = {
    id: uid(),
    at: Date.now(),
    label: label ?? "自动快照",
    resume: structuredClone(doc.resume),
    appearance: { ...doc.appearance },
  }
  return { ...doc, history: [snap, ...history].slice(0, 20) }
}

/** 建文档：默认名取「姓名-头衔」，缺失时落「我的简历」 */
export function makeDoc(resume: Resume, appearance: Appearance, name?: string): ResumeDoc {
  const { name: pName, headline } = resume.profile
  const derived = [pName, headline].filter(Boolean).join("-")
  return {
    id: uid(),
    name: name?.trim() || derived || "我的简历",
    resume,
    appearance,
    updatedAt: Date.now(),
  }
}

/**
 * persist v1（单份 {resume, appearance}）→ v2（多份集合）迁移：
 * 旧数据自动成为第一份简历；损坏数据回落示例稿，绝不丢用户入口。
 */
export function migrateV1toV2(persisted: unknown): { docs: ResumeDoc[]; activeId: string } {
  const p = (persisted ?? {}) as { resume?: unknown; appearance?: unknown }
  const resume = resumeSchema.safeParse(p.resume)
  const appearance = appearanceSchema.safeParse(p.appearance)
  const doc = makeDoc(
    resume.success ? resume.data : sampleResume,
    appearance.success ? appearance.data : defaultAppearance(),
  )
  return { docs: [doc], activeId: doc.id }
}

/**
 * v2→v3 外观校准迁移：旧默认值（13 / 1.6 / 44，由旧 schema 烘焙而来）
 * 升级为紧凑新默认（12.5 / 1.5 / 48）；用户自定义值原样保留；
 * 同时补齐新增字段（nameInline 等）。
 */
export function upgradeAppearance(a: unknown): Appearance {
  const parsed = appearanceSchema.parse(a ?? {})
  const fontSize = parsed.fontSize === 13 ? 12.5 : parsed.fontSize
  const lineHeight = parsed.lineHeight === 1.6 ? 1.5 : parsed.lineHeight
  const pagePadding = parsed.pagePadding === 44 ? 48 : parsed.pagePadding
  return { ...parsed, fontSize, lineHeight, pagePadding }
}
