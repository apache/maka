import { resumeSchema, uid, type Entry, type Resume, type SectionKey } from "./resume-schema"

/** 导入文本规范化：行尾空白剔除、3+ 连续空行压成 1 个空行、首尾空白去除 */
export function normalizeMd(text: string): string {
  return text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * 轻量 Markdown 渲染：支持 **加粗**、- 无序列表、普通段落。
 * 输出为 React 可消费的块结构，避免 dangerouslySetInnerHTML。
 */
export type MdBlock =
  | { type: "paragraph"; segments: MdSegment[] }
  | { type: "list"; items: MdItem[] }

export interface MdSegment {
  text: string
  bold: boolean
}

/** 列表项：level 0 = 一级（■），level 1 = 二级缩进（○） */
export interface MdItem {
  level: 0 | 1
  segments: MdSegment[]
}

export function parseInline(text: string): MdSegment[] {
  const segments: MdSegment[] = []
  const re = /\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), bold: false })
    segments.push({ text: m[1], bold: true })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold: false })
  return segments.filter((s) => s.text.length > 0)
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let list: MdItem[] | null = null
  let para: string[] = []

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", segments: parseInline(para.join(" ")) })
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      blocks.push({ type: "list", items: list })
      list = null
    }
  }

  for (const raw of lines) {
    const indent = (raw.match(/^\s*/)?.[0] ?? "").length
    const line = raw.trim()
    if (/^[-*]\s+/.test(line)) {
      flushPara()
      list = list ?? []
      list.push({
        level: indent >= 2 ? 1 : 0,
        segments: parseInline(line.replace(/^[-*]\s+/, "")),
      })
    } else if (line === "") {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line)
    }
  }
  flushPara()
  flushList()
  return blocks
}

/* ---------- 简历 <-> Markdown 文本（木及简历风格的导入导出） ---------- */

const entryToMd = (e: Entry) => {
  const meta = [e.subtitle, e.location].filter(Boolean).join(" · ")
  const range = [e.startDate, e.endDate].filter(Boolean).join(" - ")
  const lines = [`### ${e.title}`]
  if (meta) lines.push(meta)
  if (range) lines.push(range)
  if (e.body.trim()) lines.push(e.body.trim())
  return lines.join("\n")
}

export function resumeToMarkdown(resume: Resume): string {
  const p = resume.profile
  const out: string[] = [`# ${p.name}`]
  if (p.headline) out.push(`> ${p.headline}`)
  const contact = [p.phone, p.email, p.location, p.website].filter(Boolean)
  if (contact.length) out.push(contact.join(" | "))
  for (const key of resume.sectionOrder) {
    if (resume.hiddenSections.includes(key)) continue
    if (key === "summary" && resume.summary.trim()) {
      out.push(`## 个人总结\n\n${resume.summary.trim()}`)
    } else if (key === "work" && resume.work.length) {
      out.push(`## 工作经历\n\n${resume.work.map(entryToMd).join("\n\n")}`)
    } else if (key === "projects" && resume.projects.length) {
      out.push(`## 项目经历\n\n${resume.projects.map(entryToMd).join("\n\n")}`)
    } else if (key === "education" && resume.education.length) {
      out.push(`## 教育经历\n\n${resume.education.map(entryToMd).join("\n\n")}`)
    } else if (key === "skills" && resume.skills.length) {
      const body = resume.skills
        .map((g) => `- **${g.name}**：${g.keywords.join("、")}`)
        .join("\n")
      out.push(`## 技能特长\n\n${body}`)
    } else if (key === "custom") {
      for (const c of resume.custom) {
        out.push(`## ${c.name}\n\n${c.body.trim()}`)
      }
    }
  }
  return out.join("\n\n") + "\n"
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/* ---------- Markdown → 简历（resumeToMarkdown 的逆变换，供导入 md） ---------- */

const SECTION_TITLES: Record<string, SectionKey> = {
  个人总结: "summary",
  工作经历: "work",
  项目经历: "projects",
  教育经历: "education",
  技能特长: "skills",
}

/** 联系方式片段归类：邮箱/网址按特征，纯数字符号串按电话，其余当地点 */
function classifyContact(seg: string): "phone" | "email" | "location" | "website" {
  if (seg.includes("@")) return "email"
  if (/^https?:\/\//i.test(seg) || /^[\w-]+\.[a-z]{2,}(\/|$)/i.test(seg)) return "website"
  if (/^[+()\d\s-]{7,}$/.test(seg)) return "phone"
  return "location"
}

function parseEntryBlock(title: string, content: string[]): Entry {
  const entry: Entry = {
    id: uid(),
    title: title.trim(),
    subtitle: "",
    location: "",
    startDate: "",
    endDate: "",
    body: "",
  }
  let i = 0
  // meta 行：副标题（可含「 · 地点」）——既非时间范围也非 bullet
  const first = content[i]?.trim()
  if (first && !/^\S+\s*-\s*\S+$/.test(first) && !first.startsWith("- ")) {
    if (first.includes(" · ")) {
      const [sub = "", loc = ""] = first.split(" · ")
      entry.subtitle = sub.trim()
      entry.location = loc.trim()
    } else {
      entry.subtitle = first
    }
    i++
  }
  if (content[i] !== undefined && /^\S+\s*-\s*\S+$/.test(content[i]!.trim())) {
    const [start = "", end = ""] = content[i]!.trim().split(/\s+-\s+/)
    entry.startDate = start
    entry.endDate = end
    i++
  }
  entry.body = content.slice(i).join("\n").trim()
  return entry
}

/** 按 ### 行把章节内容切成条目块（### 前的空行/杂散内容丢弃） */
function splitEntryBlocks(lines: string[]): Array<{ title: string; content: string[] }> {
  const blocks: Array<{ title: string; content: string[] }> = []
  for (const line of lines) {
    if (/^### /.test(line)) {
      blocks.push({ title: line.slice(4).trim(), content: [] })
      continue
    }
    if (blocks.length === 0) continue
    blocks[blocks.length - 1]!.content.push(line)
  }
  return blocks
}

/** 解析导入的 Markdown 为简历（resumeToMarkdown 的逆变换）。无法识别结构时抛错。 */
export function markdownToResume(md: string): Resume {
  md = normalizeMd(md)
  let name = ""
  let headline = ""
  const contacts: string[] = []
  const sections: Array<{ key: SectionKey | "custom"; name: string; content: string[] }> = []
  let current: (typeof sections)[number] | null = null

  for (const raw of md.split("\n")) {
    const line = raw.trim()
    if (!line) {
      if (current) current.content.push("")
      continue
    }
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim()
      const key = SECTION_TITLES[title]
      current = { key: key ?? "custom", name: title, content: [] }
      sections.push(current)
      continue
    }
    if (line.startsWith("### ")) {
      if (current) current.content.push(line)
      continue
    }
    if (line.startsWith("# ")) {
      name = line.slice(2).trim()
      continue
    }
    if (line.startsWith("> ")) {
      headline = line.slice(2).trim()
      continue
    }
    if (!current && line.includes(" | ")) {
      contacts.push(...line.split(" | ").map((s) => s.trim()).filter(Boolean))
      continue
    }
    // 保留前导缩进（二级要点），仅去尾部空白
    if (current) current.content.push(raw.trimEnd())
  }

  if (sections.length === 0) {
    throw new Error("无法从 Markdown 识别简历结构（缺少 ## 章节标题）")
  }

  const sectionOrder: SectionKey[] = []
  const pushOrder = (key: SectionKey | "custom") => {
    const k: SectionKey = key === "custom" ? "custom" : key
    if (!sectionOrder.includes(k)) sectionOrder.push(k)
  }

  const summarySections = sections.filter((s) => s.key === "summary")
  const summary = summarySections.map((s) => s.content.join("\n").trim()).filter(Boolean).join("\n")
  if (summarySections.length) pushOrder("summary")

  const parseCollection = (key: "work" | "projects" | "education"): Entry[] => {
    const out: Entry[] = []
    for (const sec of sections.filter((s) => s.key === key)) {
      for (const block of splitEntryBlocks(sec.content)) {
        if (!block.title) continue
        out.push(parseEntryBlock(block.title, block.content))
      }
    }
    if (out.length) pushOrder(key)
    return out
  }

  const work = parseCollection("work")
  const projects = parseCollection("projects")
  const education = parseCollection("education")

  const skills = []
  for (const sec of sections.filter((s) => s.key === "skills")) {
    for (const line of sec.content) {
      const m = line.match(/^- \*\*(.+?)\*\*[：:]\s*(.+)$/)
      if (m) skills.push({ id: uid(), name: m[1]!, keywords: m[2]!.split("、").map((k) => k.trim()) })
    }
  }
  if (skills.length) pushOrder("skills")

  const custom = sections
    .filter((s) => s.key === "custom")
    .map((s) => ({ id: uid(), name: s.name, body: s.content.join("\n").trim() }))
  if (custom.length) pushOrder("custom")

  const profile = {
    name: name || "未命名",
    headline,
    phone: "",
    email: "",
    location: "",
    website: "",
  }
  for (const seg of contacts) {
    const kind = classifyContact(seg)
    if (kind === "phone" && !profile.phone) profile.phone = seg
    if (kind === "email" && !profile.email) profile.email = seg
    if (kind === "location" && !profile.location) profile.location = seg
    if (kind === "website" && !profile.website) profile.website = seg
  }

  return resumeSchema.parse({
    profile,
    summary,
    work,
    projects,
    education,
    skills,
    custom,
    sectionOrder,
    hiddenSections: [],
  })
}
