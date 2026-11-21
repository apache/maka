/** 简历主题：名字 + 主色 + 强调排版风格 */
export interface ResumeTheme {
  id: string
  name: string
  /** 主色（标题、模块名） */
  primary: string
  /** 次级强调色（时间、链接） */
  accent: string
  /** 正文颜色 */
  text: string
  /** 弱化文字颜色 */
  muted: string
  /** 分隔线颜色 */
  divider: string
  /** 模块标题样式 */
  headingStyle: "border" | "band" | "plain" | "dot"
  /** 标题模块是否大写（中文场景下体现为加宽字距） */
  spacedHeading: boolean
}

export const themes: ResumeTheme[] = [
  {
    id: "graphite",
    name: "石墨",
    primary: "#1f2937",
    accent: "#4b5563",
    text: "#374151",
    muted: "#9ca3af",
    divider: "#d1d5db",
    headingStyle: "border",
    spacedHeading: true,
  },
  {
    id: "ink-blue",
    name: "墨蓝",
    primary: "#1e3a5f",
    accent: "#2563eb",
    text: "#334155",
    muted: "#94a3b8",
    divider: "#e2e8f0",
    headingStyle: "band",
    spacedHeading: false,
  },
  {
    id: "forest",
    name: "松绿",
    primary: "#14532d",
    accent: "#16a34a",
    text: "#3f3f46",
    muted: "#a1a1aa",
    divider: "#e4e4e7",
    headingStyle: "dot",
    spacedHeading: false,
  },
  {
    id: "terracotta",
    name: "赭石",
    primary: "#7c2d12",
    accent: "#ea580c",
    text: "#44403c",
    muted: "#a8a29e",
    divider: "#e7e5e4",
    headingStyle: "border",
    spacedHeading: true,
  },
  {
    id: "violet",
    name: "黛紫",
    primary: "#4c1d95",
    accent: "#7c3aed",
    text: "#3f3f46",
    muted: "#a1a1aa",
    divider: "#e4e4e7",
    headingStyle: "plain",
    spacedHeading: false,
  },
  {
    id: "crimson",
    name: "绯红",
    primary: "#881337",
    accent: "#e11d48",
    text: "#44403c",
    muted: "#a8a29e",
    divider: "#e7e5e4",
    headingStyle: "band",
    spacedHeading: false,
  },
  {
    id: "classic-mono",
    name: "经典黑白",
    primary: "#111827",
    accent: "#4b5563",
    text: "#374151",
    muted: "#9ca3af",
    divider: "#e5e7eb",
    headingStyle: "plain",
    spacedHeading: true,
  },
  {
    id: "lake-teal",
    name: "湖青",
    primary: "#134e4a",
    accent: "#0d9488",
    text: "#334155",
    muted: "#94a3b8",
    divider: "#e2e8f0",
    headingStyle: "band",
    spacedHeading: false,
  },
]

export const getTheme = (id: string): ResumeTheme =>
  themes.find((t) => t.id === id) ?? themes[0]
