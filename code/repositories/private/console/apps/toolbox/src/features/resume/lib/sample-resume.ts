import type { Resume } from "./resume-schema"

/**
 * 示例默认稿：一份「示范如何写」的精品三段式简历。
 * 内容为演示性占位（〔量化〕处替换为真实数据），展示期望的叙事密度与格式。
 */
export const sampleResume: Resume = {
  profile: {
    name: "ggbdpq",
    headline: "前端工程师",
    phone: "",
    email: "ggbdpq@gmail.com",
    location: "杭州",
    website: "https://ggbdpq.cn",
    avatar: "",
    links: [{ id: "l1", label: "个人站点", url: "https://ggbdpq.cn" }],
  },
  summary:
    "前端工程师，**5 年** 深耕 React 与工程化体系：主导过 0→1 产品与多团队 monorepo 治理，习惯用数据衡量每一次改动——性能提升、缺陷下降、效率可量化。",
  work: [
    {
      id: "w1",
      title: "示例科技 · 前端团队",
      subtitle: "前端工程师",
      badge: "核心成员",
      location: "杭州",
      startDate: "2021.07",
      endDate: "至今",
      body: `- ■ **核心挑战**：业务线并行迭代、发布互相阻塞，历史包袱重、线上缺陷难定位
  - ◦ 多团队共用一套代码库，构建耗时与规范一致性持续恶化
- ■ **关键设计与实践**：
  - 主导前端 monorepo 治理（pnpm workspace + Turborepo 任务编排），构建耗时下降 **60%**
  - 设计组件库与设计 token 体系，业务组件复用率提升至 **70%**
  - 落地 Sentry 错误监控与灰度发布机制，线上问题平均定位时间从小时级降至分钟级
- ■ **结果与影响**：
  - 支撑 **6** 条业务线并行迭代，发布互不阻塞
  - 线上类型相关缺陷下降 **60%**，回归测试成本降低 **50%**`,
    },
    {
      id: "w2",
      title: "示例网络 · 电商前端",
      subtitle: "前端开发",
      location: "远程",
      startDate: "2019.07",
      endDate: "2021.06",
      body: `- ■ **核心挑战**：大促流量峰值下首屏缓慢，万级数据列表渲染卡顿
- ■ **关键设计与实践**：
  - 落地路由级代码分割与关键资源预加载，LCP 从 **4.2s** 降至 **1.6s**
  - 引入虚拟滚动方案，万级数据列表稳定 **60fps**
- ■ **结果与影响**：
  - 大促期间零性能类客诉，转化率提升 **12%**`,
    },
  ],
  projects: [
    {
      id: "p1",
      title: "涉案财物管理系统（Vue3）",
      subtitle: "为公安场景定制",
      location: "",
      startDate: "",
      endDate: "",
      body: `- ■ **核心挑战**：财物类型多且字段差异大，页面重复开发成本高
- ■ **关键设计与实践**：
  - 抽象统一字段模型与配置化表单结构，类型驱动的动态渲染
  - 对接 RFID 设备接口，批量识别与自动库位分配
- ■ **结果与影响**：
  - 新增财物类型无需重复开发，录入成本显著下降
  - 批量出入库效率提升，人工差错基本归零`,
    },
  ],
  education: [
    {
      id: "e1",
      title: "示例大学",
      subtitle: "计算机科学与技术（本科）",
      location: "",
      startDate: "2015.09",
      endDate: "2019.06",
      body: "- 主修课程：数据结构、操作系统、计算机网络\n- 校级程序设计竞赛 **二等奖**",
    },
  ],
  skills: [
    {
      id: "s1",
      name: "语言与框架",
      keywords: ["TypeScript", "React", "Next.js", "Vue", "Node.js"],
    },
    {
      id: "s2",
      name: "工程化",
      keywords: ["Vite", "Turbopack", "Zustand", "Zod", "Vitest", "Tailwind CSS"],
    },
    {
      id: "s3",
      name: "协作与效能",
      keywords: ["CI/CD", "Code Review", "Storybook", "Sentry", "灰度发布"],
    },
  ],
  custom: [
    {
      id: "c1",
      name: "开源与写作",
      body: `- 维护个人站点与开源组件，累计 **Star 〔N〕**
- 输出技术文章〔N〕篇，覆盖工程化与性能优化实践`,
    },
  ],
  sectionOrder: ["summary", "work", "projects", "education", "skills", "custom"],
  hiddenSections: [],
}
