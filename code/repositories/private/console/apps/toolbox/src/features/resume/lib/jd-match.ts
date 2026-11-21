/**
 * JD 对齐（路线图遗留首位）：目标职位描述 → 技术关键词提取 → 与简历匹配。
 * 词典法（非 AI）：可离线、可测试、结果可解释。
 */

export interface JdKeyword {
  term: string
  /** JD 中出现次数（≈ 重要度） */
  count: number
  /** 简历中是否已覆盖 */
  matched: boolean
}

export interface JdMatchResult {
  keywords: JdKeyword[]
  total: number
  matched: number
  /** 覆盖率 0-100（按命中关键词数 / 总关键词数） */
  coverage: number
}

/** 技术词典：前端为主，兼顾全栈与通用工程词（持续可扩充） */
const TECH_TERMS: string[] = [
  // 框架 / 语言
  "React", "Vue", "Next.js", "Nuxt", "TypeScript", "JavaScript", "ES6+", "ES2020",
  // 样式 / UI
  "Tailwind CSS", "Sass", "Less", "CSS3", "HTML5", "Element UI", "Ant Design", "shadcn",
  "组件库", "设计系统", "响应式布局", "可视化大屏",
  // 工程
  "Webpack", "Vite", "Turbopack", "Rollup", "Babel", "ESLint", "Prettier", "monorepo",
  "pnpm", "CI/CD", "微前端", "SSR", "SSG", "服务端渲染", "懒加载", "虚拟滚动",
  // 运行时 / 服务端
  "Node.js", "NestJS", "Express", "Koa", "GraphQL", "RESTful", "WebSocket", "SSE",
  "微服务", "Docker", "Kubernetes", "K8s", "Nginx",
  // 数据 / 状态
  "Zustand", "Redux", "Pinia", "Vuex", "React Query", "TanStack", "SWR",
  // 质量与专项
  "单元测试", "E2E", "Vitest", "Jest", "Playwright", "Cypress",
  "性能优化", "首屏加载", "内存泄漏", "体验优化", "埋点", "监控告警", "灰度发布",
  "权限控制", "RBAC", "国际化", "i18n", "无障碍", "可访问性", "安全加固",
  "AI 工程化", "LLM", "大模型", "RAG", "Prompt",
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 从 JD 提取技术关键词（词典命中 + 出现次数排序），命中不到词典的高频英文词忽略 */
export function extractJdKeywords(jd: string): JdKeyword[] {
  const text = jd.toLowerCase()
  const out: JdKeyword[] = []
  for (const term of TECH_TERMS) {
    const re = new RegExp(escapeRe(term.toLowerCase()), "g")
    const count = (text.match(re) ?? []).length
    if (count > 0) out.push({ term, count, matched: false })
  }
  return out.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
}

/** 简历全文（标题/正文/技能等拼合） */
export function resumeTextOf(resume: unknown): string {
  try {
    return JSON.stringify(resume).toLowerCase()
  } catch {
    return ""
  }
}

/** 匹配：JD 关键词 × 简历全文 → 覆盖率报告 */
export function matchResumeToJd(jdKeywords: JdKeyword[], resumeText: string): JdMatchResult {
  const keywords = jdKeywords.map((k) => {
    const re = new RegExp(escapeRe(k.term.toLowerCase()), "i")
    return { ...k, matched: re.test(resumeText) }
  })
  const matched = keywords.filter((k) => k.matched).length
  const total = keywords.length
  return {
    keywords,
    total,
    matched,
    coverage: total ? Math.round((matched / total) * 100) : 0,
  }
}
