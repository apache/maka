import type { Resume } from "./resume-schema"
import { sampleResume } from "./sample-resume"

export interface ResumeTemplate {
  id: string
  name: string
  description: string
  themeId: string
  resume: Resume
}

/** 校招 / 实习向模板 */
const campusResume: Resume = {
  ...sampleResume,
  profile: {
    ...sampleResume.profile,
    name: "苏晚晴",
    headline: "2026 届本科毕业生 · 求职意向：前端开发",
    location: "北京",
    email: "wanqing.su@example.com",
    links: [{ id: "l1", label: "GitHub", url: "https://github.com/wanqing" }],
  },
  summary:
    "计算机专业 2026 届本科生，熟悉 **React / TypeScript**，有两段前端实习经历。热衷开源，乐于折腾新技术，希望加入重视工程文化的团队。",
  work: [
    {
      id: "w1",
      title: "橙子互娱",
      subtitle: "前端开发实习生",
      location: "北京",
      startDate: "2025.06",
      endDate: "2025.12",
      body: "- 参与 C 端活动页开发，独立完成 6 个活动页，PV 累计 300w+\n- 优化首屏资源加载，**LCP 降低 40%**\n- 协助搭建组件文档站，沉淀 20+ 业务组件用例",
    },
  ],
  projects: [
    {
      id: "p1",
      title: "校园课表 App",
      subtitle: "独立开发 · 全校 3000+ 用户",
      location: "",
      startDate: "2024.09",
      endDate: "2025.03",
      body: "- React Native + Expo 全栈独立开发，覆盖课表查询、成绩订阅\n- 实现教务系统自动登录与数据抓取，日活峰值 1200",
    },
  ],
  education: [
    {
      id: "e1",
      title: "北京邮电大学",
      subtitle: "软件工程 · 本科（预计 2026 年毕业）",
      location: "北京",
      startDate: "2022.09",
      endDate: "2026.06",
      body: "- GPA 3.7 / 4.0，专业前 10%\n- 蓝桥杯全国二等奖，校开源协会会长",
    },
  ],
  skills: [
    { id: "s1", name: "前端", keywords: ["React", "TypeScript", "Vite", "Tailwind CSS"] },
    { id: "s2", name: "后端与其他", keywords: ["Node.js", "Python", "Git", "Figma"] },
  ],
  custom: [],
  sectionOrder: ["summary", "education", "work", "projects", "skills"],
  hiddenSections: [],
}

/** 极简英文简历模板 */
const minimalEnResume: Resume = {
  ...sampleResume,
  profile: {
    ...sampleResume.profile,
    name: "Alex Chen",
    headline: "Full-Stack Engineer",
    location: "Remote",
    email: "alex.chen@example.com",
    phone: "+1 555-0100",
    links: [{ id: "l1", label: "Portfolio", url: "https://alexchen.dev" }],
  },
  summary:
    "Product-minded engineer with 6 years of experience shipping **web applications** end to end. Care deeply about performance, accessibility and developer experience.",
  work: [
    {
      id: "w1",
      title: "Nova Labs",
      subtitle: "Senior Frontend Engineer",
      location: "Remote",
      startDate: "2022.03",
      endDate: "Present",
      body: "- Led the rebuild of the dashboard product with **React 19 + Vite**, cutting bundle size by 45%\n- Introduced end-to-end testing with Playwright, regression bugs down 70%\n- Mentored 3 junior engineers and drove the adoption of TypeScript strict mode",
    },
    {
      id: "w2",
      title: "Brightline",
      subtitle: "Frontend Engineer",
      location: "San Francisco",
      startDate: "2019.06",
      endDate: "2022.02",
      body: "- Built the customer portal used by 200k monthly active users\n- Designed a shared component library adopted across 5 teams",
    },
  ],
  projects: [],
  education: [
    {
      id: "e1",
      title: "University of Washington",
      subtitle: "B.S. Computer Science",
      location: "Seattle",
      startDate: "2015.09",
      endDate: "2019.06",
      body: "",
    },
  ],
  skills: [
    { id: "s1", name: "Core", keywords: ["TypeScript", "React", "Node.js", "GraphQL"] },
    { id: "s2", name: "Tooling", keywords: ["Vite", "Playwright", "Vitest", "Docker"] },
  ],
  custom: [],
  sectionOrder: ["summary", "work", "education", "skills"],
  hiddenSections: [],
}

const templates: ResumeTemplate[] = [
  {
    id: "experienced",
    name: "资深工程师",
    description: "适合 5 年以上经验，突出架构与业务成果",
    themeId: "graphite",
    resume: sampleResume,
  },
  {
    id: "campus",
    name: "校招求职",
    description: "教育与实习前置，适合应届与实习申请",
    themeId: "ink-blue",
    resume: campusResume,
  },
  {
    id: "minimal-en",
    name: "Minimal EN",
    description: "极简英文简历，外企与远程岗位友好",
    themeId: "forest",
    resume: minimalEnResume,
  },
]

/** 模拟远端获取模板列表 —— 供 TanStack Query 使用 */
export async function fetchTemplates(): Promise<ResumeTemplate[]> {
  await new Promise((r) => setTimeout(r, 300))
  return templates
}

export async function fetchTemplate(id: string): Promise<ResumeTemplate | undefined> {
  await new Promise((r) => setTimeout(r, 150))
  return templates.find((t) => t.id === id)
}
