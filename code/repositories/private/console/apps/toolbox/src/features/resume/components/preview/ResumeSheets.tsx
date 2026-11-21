"use client"

// 多页渲染（T08）+ 智能一页多级降档（T09）：
// 1. 把纸面内容切成原子块（头部 / 各章节 / 条目粒度）
// 2. 隐藏测量容器逐块测高（em 体系下与纸面同宽同字号，测量保真）
// 3. 智能一页：总高 ≤ 1.45 页时按「行距→字号」多级降档塞进一页；
//    超过后按块贪心装箱成多张 A4（块前边距折算进高度）。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Globe, Mail, MapPin, Phone } from "lucide-react"
import { SectionHeading, EntryBlock } from "./ResumePaper"
import { MdText } from "./MdText"
import { getTheme, type ResumeTheme } from "@/features/resume/lib/themes"
import { useResumeStore } from "@/features/resume/store/resume-store"
import type { Appearance, Resume } from "@/features/resume/lib/resume-schema"

const CONTACT_ICONS = {
  phone: Phone,
  email: Mail,
  location: MapPin,
  website: Globe,
} as const

const A4_WIDTH = 794
const A4_HEIGHT = 1123

interface PaperBlock {
  key: string
  /** 章节起始块（新页从它开头更自然），条目续排块 */
  kind: "header" | "section-start" | "item"
  /** 块底部留白（计入高度），pb 形式使 rect.height 直接可用 */
  pb: string
  node: React.ReactNode
}

function buildBlocks(resume: Resume, appearance: Appearance, theme: ResumeTheme): PaperBlock[] {
  const p = resume.profile
  const sections = resume.sectionOrder.filter((k) => !resume.hiddenSections.includes(k))
  const blocks: PaperBlock[] = []

  blocks.push({
    key: "header",
    kind: "header",
    pb: "pb-6",
    node: (
      <header className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1
            className="text-[2.1em] font-bold leading-tight tracking-wide"
            style={{ color: theme.primary }}
          >
            {appearance.nameInline && p.headline
              ? `${p.name || "你的姓名"} - ${p.headline}`
              : p.name || "你的姓名"}
          </h1>
          {!appearance.nameInline && p.headline && (
            <p className="mt-1 text-[1.05em] font-medium" style={{ color: theme.accent }}>
              {p.headline}
            </p>
          )}
          {p.phone || p.email || p.location || p.website ? (
            <div
              className="mt-3 grid grid-cols-2 gap-x-10 gap-y-1 text-[0.85em]"
              style={{ color: theme.muted }}
            >
              {(
                [
                  p.phone && { kind: "phone", label: "手机", value: p.phone },
                  p.email && { kind: "email", label: "邮箱", value: p.email },
                  p.location && { kind: "location", label: "城市", value: p.location },
                  p.website && { kind: "website", label: "网站", value: p.website },
                ].filter(Boolean) as { kind: keyof typeof CONTACT_ICONS; label: string; value: string }[]
              ).map((item) => {
                const Icon = CONTACT_ICONS[item.kind]
                return (
                  <span key={item.label} className="inline-flex items-center gap-1.5">
                    <Icon className="h-[1em] w-[1em]" />
                    <span>
                      {item.label}：{item.value}
                    </span>
                  </span>
                )
              })}
            </div>
          ) : null}
          {p.links.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.85em]">
              {p.links.map((link) => (
                <a key={link.id} href={link.url} target="_blank" rel="noreferrer">
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
        {appearance.showAvatar && p.avatar && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.avatar}
            alt={p.name}
            className="size-24 shrink-0 rounded-lg object-cover"
            style={{ outline: `2px solid ${theme.divider}` }}
          />
        )}
      </header>
    ),
  })

  const entryBlocks = (kindPrefix: string, title: string, list: Resume["work"]) => {
    list.forEach((e, i) => {
      blocks.push({
        key: `${kindPrefix}-${e.id}`,
        kind: i === 0 ? "section-start" : "item",
        pb: i === list.length - 1 ? "pb-6" : "pb-4",
        node: (
          <div>
            {i === 0 && <SectionHeading title={title} theme={theme} />}
            <div className={i === 0 ? "mt-1 space-y-4" : "space-y-4"}>
              <EntryBlock entry={e} theme={theme} />
            </div>
          </div>
        ),
      })
    })
  }

  if (resume.summary.trim()) {
    blocks.push({
      key: "summary",
      kind: "section-start",
      pb: "pb-6",
      node: (
        <section>
          <SectionHeading title="个人总结" theme={theme} />
          <MdText text={resume.summary} className="mt-1 space-y-1.5 text-[0.95em]" />
        </section>
      ),
    })
  }

  entryBlocks("work", "工作经历", resume.work)
  entryBlocks("projects", "项目经历", resume.projects)
  entryBlocks("education", "教育经历", resume.education)

  if (resume.skills.length) {
    blocks.push({
      key: "skills",
      kind: "section-start",
      pb: "pb-6",
      node: (
        <section>
          <SectionHeading title="技能特长" theme={theme} />
          <div className="mt-1 space-y-1.5 text-[0.95em]">
            {resume.skills.map((g) => (
              <div key={g.id} className="flex gap-2">
                <span className="shrink-0 font-semibold" style={{ color: theme.primary }}>
                  {g.name}：
                </span>
                <span>{g.keywords.join("、")}</span>
              </div>
            ))}
          </div>
        </section>
      ),
    })
  }

  for (const c of resume.custom) {
    if (!c.body.trim()) continue
    blocks.push({
      key: `custom-${c.id}`,
      kind: "section-start",
      pb: "pb-6",
      node: (
        <section>
          <SectionHeading title={c.name} theme={theme} />
          <MdText text={c.body} className="mt-1 space-y-1.5 text-[0.95em]" />
        </section>
      ),
    })
  }

  return blocks
}

/** 降档序列：原样 → 压行距 → 压行距+字号 → 底线（T09 多级降档） */
function downgradeLevels(a: Appearance): Array<{ fontSize: number; lineHeight: number }> {
  const fs = a.fontSize
  const lh = a.lineHeight
  return [
    { fontSize: fs, lineHeight: lh },
    { fontSize: fs, lineHeight: Math.max(1.2, lh - 0.15) },
    { fontSize: Math.max(11, fs - 0.5), lineHeight: Math.max(1.2, lh - 0.3) },
    { fontSize: Math.max(11, fs - 1), lineHeight: 1.2 },
  ]
}

/** 贪心装箱：按块高度把块分进多页 */
function packBlocks(blocks: PaperBlock[], heights: number[], avail: number): PaperBlock[][] {
  const pages: PaperBlock[][] = []
  let cur: PaperBlock[] = []
  let used = 0
  blocks.forEach((b, i) => {
    const h = heights[i] ?? 0
    if (cur.length && used + h > avail) {
      pages.push(cur)
      cur = []
      used = 0
    }
    cur.push(b)
    used += h
  })
  if (cur.length) pages.push(cur)
  return pages
}

export function ResumeSheets({
  resume,
  appearance,
}: {
  resume: Resume
  appearance: Appearance
}) {
  const baseTheme = getTheme(appearance.themeId)
  // theme 必须稳定（memo），否则 blocks 反复重建 → 测量 effect 无限循环
  const theme = useMemo(
    () => ({
      ...baseTheme,
      ...(appearance.accentOverride ? { accent: appearance.accentOverride } : {}),
    }),
    [baseTheme, appearance.accentOverride],
  )
  const fontFamily =
    appearance.fontFamily === "serif"
      ? 'Georgia, "Times New Roman", "Songti SC", serif'
      : undefined
  const contentWidth = A4_WIDTH - appearance.pagePadding * 2
  const availHeight = A4_HEIGHT - appearance.pagePadding * 2

  const blocks = useMemo(
    () => buildBlocks(resume, appearance, theme),
    [resume, appearance, theme],
  )

  // 测量通道：与纸面同宽同字号的隐藏容器
  const measureRef = useRef<HTMLDivElement>(null)
  const [heights, setHeights] = useState<number[] | null>(null)

  useLayoutEffect(() => {
    if (!measureRef.current) return
    setHeights(
      [...measureRef.current.children].map(
        (c) => c.getBoundingClientRect().height,
      ),
    )
  }, [blocks])

  const totalHeight = heights ? heights.reduce((a, b) => a + b, 0) : 0

  // 智能一页：总高 ≤ 1.45 页 → 降档塞一页；否则多页
  const levels = downgradeLevels(appearance)
  const fitLevel =
    appearance.fitToOnePage && totalHeight > availHeight && totalHeight <= availHeight * 1.45
      ? (levels.find((_, i) => {
          const ratio =
            (levels[i]!.fontSize / appearance.fontSize) *
            (levels[i]!.lineHeight / appearance.lineHeight)
          return totalHeight * ratio <= availHeight
        }) ?? levels[levels.length - 1]!)
      : null

  const paginate = !fitLevel
  const effective = fitLevel ?? levels[0]!

  // 打包（高度按降档比率折算；未测量时先单页兜底）
  const pages: PaperBlock[][] = heights
    ? paginate
      ? packBlocks(blocks, heights, availHeight)
      : [blocks]
    : [blocks]

  // 上报实渲染页数（质量分篇幅维度用真实值）
  const setLastPages = useResumeStore((s) => s.setLastPages)
  useEffect(() => {
    if (heights) setLastPages(pages.length)
  }, [heights, pages.length, setLastPages])

  return (
    <div className="flex flex-col items-center gap-8">
      {pages.map((page, i) => (
        <div
          key={i}
          data-sheet={i}
          className="resume-sheet relative bg-white shadow-[0_2px_24px_rgba(0,0,0,0.12)]" // style:ok A4 纸张物理白
          style={{
            width: A4_WIDTH,
            minHeight: A4_HEIGHT,
            padding: appearance.pagePadding,
            fontSize: effective.fontSize,
            lineHeight: effective.lineHeight,
            color: theme.text,
            fontFamily,
            breakAfter: i < pages.length - 1 ? "page" : undefined,
          }}
        >
          {page.map((b) => (
            <div key={b.key} className={b.pb}>
              {b.node}
            </div>
          ))}
        </div>
      ))}

      {/* 隐藏测量容器：与纸面内容同宽同字号 */}
      <div
        ref={measureRef}
        aria-hidden
        className="invisible absolute"
        style={{
          width: contentWidth,
          fontSize: appearance.fontSize,
          lineHeight: appearance.lineHeight,
          color: theme.text,
          fontFamily,
        }}
      >
        {blocks.map((b) => (
          <div key={b.key} className={b.pb}>
            {b.node}
          </div>
        ))}
      </div>
    </div>
  )
}
