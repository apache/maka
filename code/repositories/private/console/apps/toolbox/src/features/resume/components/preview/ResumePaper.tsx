"use client"

import { Globe, Link2, Mail, MapPin, Phone } from "lucide-react"
import { cn } from "@ggbdpq/console-ui"
import type { Appearance, Entry, Resume } from "@/features/resume/lib/resume-schema"
import { getTheme, type ResumeTheme } from "@/features/resume/lib/themes"
import { MdText } from "./MdText"

/** A4 纸在 96dpi 下的像素尺寸 */
export const A4_WIDTH = 794
export const A4_HEIGHT = 1123

export function SectionHeading({
  title,
  theme,
}: {
  title: string
  theme: ResumeTheme
}) {
  const style = theme.headingStyle
  return (
    <div className="mb-3">
      {style === "band" ? (
        <h2
          className="inline-block rounded-sm px-3 py-1 text-[1.05em] font-bold tracking-widest text-white" // style:ok 白字挂在下方动态简历主题底色上，静态 token 无法表达
          style={{ backgroundColor: theme.primary }}
        >
          {title}
        </h2>
      ) : (
        <h2
          className="flex items-center gap-2 text-[1.15em] font-bold"
          style={{
            color: theme.primary,
            letterSpacing: theme.spacedHeading ? "0.35em" : "0.1em",
          }}
        >
          {style === "dot" && (
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: theme.accent }}
            />
          )}
          {title}
        </h2>
      )}
      {style === "border" && (
        <div
          className="mt-1.5 h-px w-full"
          style={{ backgroundColor: theme.divider }}
        />
      )}
      {style === "plain" && (
        <div
          className="mt-1.5 h-[3px] w-10 rounded-full"
          style={{ backgroundColor: theme.accent }}
        />
      )}
    </div>
  )
}

export function EntryBlock({ entry, theme }: { entry: Entry; theme: ResumeTheme }) {
  const range = [entry.startDate, entry.endDate].filter(Boolean).join(" — ")
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="flex flex-wrap items-baseline gap-2 text-[1.05em] font-semibold" style={{ color: theme.primary }}>
          {entry.title}
          {entry.badge && (
            <span
              className="rounded-sm px-1.5 py-px text-[0.72em] font-normal"
              style={{ backgroundColor: theme.muted, color: "#fff" }}
            >
              {entry.badge}
            </span>
          )}
        </h3>
        {range && (
          <span className="shrink-0 text-[0.85em] tabular-nums" style={{ color: theme.muted }}>
            {range}
          </span>
        )}
      </div>
      {(entry.subtitle || entry.location) && (
        <div
          className="mt-0.5 flex items-baseline justify-between gap-4 text-[0.92em]"
          style={{ color: theme.accent }}
        >
          <span className="font-medium">{entry.subtitle}</span>
          {entry.location && (
            <span className="shrink-0" style={{ color: theme.muted }}>
              {entry.location}
            </span>
          )}
        </div>
      )}
      {entry.body.trim() && (
        <MdText text={entry.body} className="mt-1.5 space-y-1 text-[0.95em]" />
      )}
    </div>
  )
}

export function ResumePaper({
  resume,
  appearance,
}: {
  resume: Resume
  appearance: Appearance
}) {
  const theme = {
    ...getTheme(appearance.themeId),
    ...(appearance.accentOverride ? { accent: appearance.accentOverride } : {}),
  }
  const fontFamily =
    appearance.fontFamily === "serif"
      ? 'Georgia, "Times New Roman", "Songti SC", serif'
      : undefined
  const p = resume.profile
  const sections = resume.sectionOrder.filter(
    (k) => !resume.hiddenSections.includes(k),
  )

  const contactItems = [
    p.phone && { icon: Phone, label: "手机", value: p.phone },
    p.email && { icon: Mail, label: "邮箱", value: p.email },
    p.location && { icon: MapPin, label: "城市", value: p.location },
    p.website && { icon: Globe, label: "网站", value: p.website },
  ].filter(Boolean) as { icon: typeof Phone; label: string; value: string }[]

  return (
    <div
      data-testid="resume-paper"
      className="mx-auto bg-white shadow-[0_2px_24px_rgba(0,0,0,0.12)]" // style:ok A4 纸张物理白，明暗两板下纸面都必须是纸白
      style={{
        width: A4_WIDTH,
        minHeight: A4_HEIGHT,
        padding: appearance.pagePadding,
        fontSize: appearance.fontSize,
        lineHeight: appearance.lineHeight,
        color: theme.text,
        fontFamily,
      }}
    >
      {/* 头部：姓名 - 头衔同行（木及式，可关闭回两行） */}
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
          {contactItems.length > 0 && (
            <div
              className="mt-3 grid grid-cols-2 gap-x-10 gap-y-1 text-[0.85em]"
              style={{ color: theme.muted }}
            >
              {contactItems.map((item, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  <item.icon className="h-[1em] w-[1em]" />
                  <span>
                    {item.label}：{item.value}
                  </span>
                </span>
              ))}
            </div>
          )}
          {p.links.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.85em]">
              {p.links.map((link) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  style={{ color: theme.accent }}
                >
                  <Link2 className="h-[1em] w-[1em]" />
                  {link.label}
                </a>
              ))}
            </div>
          )}
        </div>
        {appearance.showAvatar && p.avatar && (
          <img
            src={p.avatar}
            alt={p.name}
            className={cn(
              "h-24 w-24 shrink-0 object-cover",
              appearance.avatarRound ? "rounded-full" : "rounded-lg",
            )}
            style={{ outline: `2px solid ${theme.divider}` }}
          />
        )}
      </header>

      <div
        className="my-5 h-px w-full"
        style={{ backgroundColor: theme.divider }}
      />

      {/* 模块 */}
      <main className="space-y-6">
        {sections.map((key) => {
          if (key === "summary" && resume.summary.trim()) {
            return (
              <section key={key}>
                <SectionHeading title="个人总结" theme={theme} />
                <MdText text={resume.summary} className="space-y-1.5 text-[0.95em]" />
              </section>
            )
          }
          const sectionOf = (title: string, list: Entry[]) =>
            list.length > 0 && (
              <section key={key}>
                <SectionHeading title={title} theme={theme} />
                <div className="space-y-4">
                  {list.map((e) => (
                    <EntryBlock key={e.id} entry={e} theme={theme} />
                  ))}
                </div>
              </section>
            )
          if (key === "work") return sectionOf("工作经历", resume.work)
          if (key === "projects") return sectionOf("项目经历", resume.projects)
          if (key === "education") return sectionOf("教育经历", resume.education)
          if (key === "skills" && resume.skills.length) {
            return (
              <section key={key}>
                <SectionHeading title="技能特长" theme={theme} />
                <div className="space-y-1.5 text-[0.95em]">
                  {resume.skills.map((g) => (
                    <div key={g.id} className="flex gap-2">
                      <span
                        className="shrink-0 font-semibold"
                        style={{ color: theme.primary }}
                      >
                        {g.name}：
                      </span>
                      <span>{g.keywords.join("、")}</span>
                    </div>
                  ))}
                </div>
              </section>
            )
          }
          if (key === "custom") {
            // 空 body 的自定义模块不渲染（避免空标题）
            return resume.custom
              .filter((c) => c.body.trim())
              .map((c) => (
                <section key={c.id}>
                  <SectionHeading title={c.name} theme={theme} />
                  <MdText text={c.body} className="space-y-1.5 text-[0.95em]" />
                </section>
              ))
          }
          return null
        })}
      </main>
    </div>
  )
}
