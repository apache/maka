/**
 * 简历质量分（R4）：五维纯函数评分（G7 诚实命名，不冒充 ATS 分）。
 * 完整性 30 / 量化率 25 / 动词强度 20 / 篇幅 15 / 多样性 10。
 */
import type { Resume } from "@/features/resume/lib/resume-schema"
import { reviewEntryBody } from "./content-review"

export interface ScoreDimension {
  key: string
  label: string
  score: number
  max: number
  advice: string
}

export interface ResumeScore {
  total: number
  grade: "优" | "中" | "待改进"
  dimensions: ScoreDimension[]
}

const allBullets = (r: Resume): string[] => {
  const bodies = [r.summary, ...[...r.work, ...r.projects, ...r.education].map((e) => e.body)]
  const bullets: string[] = []
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const t = line.trim()
      if (/^-\s+/.test(t) && t.replace(/^-\s*/, "").length >= 6) bullets.push(t)
    }
  }
  return bullets
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(n)))

export function scoreResume(r: Resume, opts?: { pages?: number }): ResumeScore {
  const p = r.profile
  // —— 完整性 30 ——
  const profileFields = [p.headline, p.phone, p.email, p.location].filter(Boolean).length
  const workReady = r.work.filter(
    (e) => e.title && reviewEntryBody(e.body).quantify.length === 0 && e.body.split("\n").filter((l) => l.trim()).length >= 2,
  )
  let completeness = 0
  completeness += (profileFields / 4) * 10
  if (r.summary.trim().length >= 30) completeness += 6
  if (r.work.length > 0) completeness += 4
  completeness += r.work.length ? (workReady.length / r.work.length) * 10 : 0
  const completenessScore = clamp(completeness, 30)

  // —— 量化率 25 ——
  const bullets = allBullets(r)
  const QUANT = /\d|%|％|倍|万|亿|k\b|K\b|Q[1-4]/
  const quantified = bullets.filter((b) => QUANT.test(b)).length
  const quantScore = clamp(bullets.length ? (quantified / bullets.length) * 25 : 0, 25)

  // —— 动词强度 20 ——
  const weakHits = [...r.work, ...r.projects].reduce(
    (n, e) => n + reviewEntryBody(e.body).weakVerb.length,
    0,
  )
  const verbScore = clamp(bullets.length ? 20 - (weakHits / bullets.length) * 40 : 0, 20)

  // —— 篇幅 15 ——
  const pages = opts?.pages ?? Math.max(1, Math.ceil(bullets.length / 14))
  const lengthScore = pages === 1 ? 15 : pages === 2 ? 10 : 6

  // —— 多样性 10 ——
  const leadVerbs = new Set(bullets.map((b) => b.replace(/^-\s*/, "").slice(0, 2)))
  const diversityScore = clamp(bullets.length ? (leadVerbs.size / bullets.length) * 10 : 0, 10)

  const dimensions: ScoreDimension[] = [
    {
      key: "completeness",
      label: "信息完整性",
      score: completenessScore,
      max: 30,
      advice: "补齐联系方式四项、个人总结（≥30 字），每段经历至少两条实质要点",
    },
    {
      key: "quantify",
      label: "量化率",
      score: quantScore,
      max: 25,
      advice: `已有 ${quantified}/${bullets.length} 条要点含量化数据——给每条结论配数字（百分比/倍数/耗时）`,
    },
    {
      key: "verb",
      label: "动词强度",
      score: verbScore,
      max: 20,
      advice: "把「负责/参与/进行了」换成主导/重构/落地/沉淀等强动词开头",
    },
    {
      key: "length",
      label: "篇幅预算",
      score: lengthScore,
      max: 15,
      advice: pages > 1 ? `${pages} 页偏长——社招黄金篇幅 1 页，砍低相关性条目` : "篇幅合适",
    },
    {
      key: "diversity",
      label: "开头多样性",
      score: diversityScore,
      max: 10,
      advice: "要点开头动词重复率高会显得单调——换用不同动作词",
    },
  ]

  const total = dimensions.reduce((n, d) => n + d.score, 0)
  const grade = total >= 80 ? "优" : total >= 60 ? "中" : "待改进"
  return { total, grade, dimensions }
}
