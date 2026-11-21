/**
 * 要点范例库（R2）：精选高质量 bullet，点击以二级要点插入条目 body。
 * 质量标准（G3-28）：动词开头 + 含〔量化〕占位 + 无空话。
 */

export type BulletSection = "work" | "project"
export type BulletTopic = "性能优化" | "架构设计" | "从零到一" | "协作与效能"

export interface BulletExample {
  id: string
  section: BulletSection
  topic: BulletTopic
  text: string
}

export const BULLET_LIBRARY: BulletExample[] = [
  // —— 工作经历 · 性能优化 ——
  { id: "w-perf-1", section: "work", topic: "性能优化", text: "主导首屏加载优化，通过路由级代码分割与关键资源预加载，LCP 从〔4.2s〕降至〔1.6s〕" },
  { id: "w-perf-2", section: "work", topic: "性能优化", text: "落地长列表虚拟滚动方案，万级数据渲染稳定 60fps，内存占用下降〔40%〕" },
  { id: "w-perf-3", section: "work", topic: "性能优化", text: "治理打包体积：依赖审计 + 按需引入 + tree-shaking 校准，产物从〔2.8MB〕压缩至〔1.1MB〕" },
  // —— 工作经历 · 架构设计 ——
  { id: "w-arch-1", section: "work", topic: "架构设计", text: "从零搭建前端 monorepo 工程体系（pnpm workspace + Turborepo），支撑〔6〕条业务线并行迭代" },
  { id: "w-arch-2", section: "work", topic: "架构设计", text: "设计组件库与设计 token 体系，业务组件复用率提升至〔70%〕，新页面开发周期缩短〔30%〕" },
  { id: "w-arch-3", section: "work", topic: "架构设计", text: "推动微前端架构落地，隔离〔3〕个团队交付节奏，发布互不阻塞" },
  { id: "w-arch-4", section: "work", topic: "架构设计", text: "沉淀前端错误监控与告警体系（Sentry + SourceMap），线上问题平均定位时间从小时级降至分钟级" },
  // —— 工作经历 · 从零到一 ——
  { id: "w-zero-1", section: "work", topic: "从零到一", text: "独立完成〔CRM 后台〕从 0 到 1 搭建与上线，覆盖〔12〕个核心模块，〔3〕周交付 MVP" },
  { id: "w-zero-2", section: "work", topic: "从零到一", text: "主导移动端适配体系落地，一次开发多端生效，机型兼容覆盖〔98%〕" },
  // —— 工作经历 · 协作与效能 ——
  { id: "w-collab-1", section: "work", topic: "协作与效能", text: "推动前端 CI/CD 流水线建设（lint + 单测 + 预览环境），回归测试成本降低〔50%〕" },
  { id: "w-collab-2", section: "work", topic: "协作与效能", text: "制定 TypeScript 规范与 Code Review 清单，线上类型相关缺陷下降〔60%〕" },
  { id: "w-collab-3", section: "work", topic: "协作与效能", text: "搭建组件文档与 playground（Storybook），设计-前端联调成本减半" },
  // —— 项目 · 性能优化 ——
  { id: "p-perf-1", section: "project", topic: "性能优化", text: "针对大表单重渲染问题，落地状态分层与 memo 边界，交互延迟从〔800ms〕降至〔90ms〕" },
  { id: "p-perf-2", section: "project", topic: "性能优化", text: "设计图片懒加载 + CDN 多级缓存方案，带宽成本下降〔35%〕" },
  { id: "p-perf-3", section: "project", topic: "性能优化", text: "定位并修复内存泄漏〔3〕处，服务长时间运行崩溃率归零" },
  // —— 项目 · 架构设计 ——
  { id: "p-arch-1", section: "project", topic: "架构设计", text: "抽象统一权限模型（RBAC + 按钮级指令），新增受限页面开发成本从〔2 天〕降至〔2 小时〕" },
  { id: "p-arch-2", section: "project", topic: "架构设计", text: "设计 Schema 驱动的动态表单引擎，〔6〕类差异化表单配置化生成，迭代效率提升〔3 倍〕" },
  { id: "p-arch-3", section: "project", topic: "架构设计", text: "设计图表抽象层统一数据请求与异常处理，多图表时间联动与点击钻取一次成型" },
  // —— 项目 · 从零到一 ——
  { id: "p-zero-1", section: "project", topic: "从零到一", text: "独立设计并实现〔可视化大屏〕模块，覆盖〔8〕类图表，支持多指标联动与钻取" },
  { id: "p-zero-2", section: "project", topic: "从零到一", text: "从零实现 Markdown 渲染引擎，支持主题系统与智能一页排版" },
  { id: "p-zero-3", section: "project", topic: "从零到一", text: "主导小程序端 AI 对话链路落地：多轮会话、流式回答与业务卡片混合渲染" },
  // —— 项目 · 协作与效能 ——
  { id: "p-collab-1", section: "project", topic: "协作与效能", text: "牵头跨端协作规范（接口契约先行 + Mock 并行），前后端联调周期缩短〔40%〕" },
  { id: "p-collab-2", section: "project", topic: "协作与效能", text: "引入 MSW 与契约测试，前端可独立于后端进度开发" },
  { id: "p-collab-3", section: "project", topic: "协作与效能", text: "落地灰度发布与 feature flag 机制，线上事故回滚时间缩短至〔5 分钟〕" },
]

export const BULLET_TOPICS: BulletTopic[] = ["性能优化", "架构设计", "从零到一", "协作与效能"]
