# console

个人多应用工作台聚合：AI Agent 工作台 + 运维控制台 + 个人博客 + 演示工具箱。架构、边界与迁移对照见 [AGENTS.md](./AGENTS.md)；任务裁决入口为 `.ggbdpq/`。

## 快速开始

```bash
pnpm install
pnpm dev            # 一键全启(门户 65515 / 控制台 65501 / 博客 65502 / 工具箱 65503 / Agent 65504)
pnpm dev:console    # 控制台 http://localhost:65501
pnpm dev:portal     # 门户   http://localhost:65515
pnpm dev:blog       # 博客   http://localhost:65502
pnpm dev:toolbox    # 工具箱 http://localhost:65503
pnpm dev:agent      # Agent  http://localhost:65504
```

## 应用与包

| 目录 | 定位 |
|---|---|
| `apps/console` | 运维控制台(65501)：资产/库存/注册/工具集/清单/书签/实践 |
| `apps/blog` | 个人博客(65502)：朋友圈/文章/算法判题/成长/动漫/技能展示 |
| `apps/toolbox` | 演示与本地工具(65503)：论坛/演示后台/简历编辑器/约会攻略/聊天查看器/AI 日报/数据库对比/组件陈列室 |
| `apps/agent` | AI Agent 工作台(65504)：配置/治理/实验室/执行引擎/Worktree 台/课程/幻灯片/面试自练场/变更审查（2026-09-19 自 65501/65503 收拢；2026-10-03 六期并入 interview-gym 与 diffmap） |
| `apps/cli` | Commander CLI（doctor/register/toolkit/prism/diffmap 等子命令） |
| `packages/ui` | shadcn/ui 定制层（46 个组件导出） |
| `packages/shared` | 跨端 Zod schema（todo 域走 `@ggbdpq/console-shared/todo` 子路径） |
| `packages/inventory-core` | 库存领域核心 |
| `packages/register-core` | 注册引擎（gpt-free-register 迁入，CLI 与 API 共用） |
| `packages/mail-sdk` | 邮件收信 SDK（IMAP/Graph/Gmail/mail.tm） |
| `packages/toolkit-core` | 批量注册工具（registration-toolkit 独有部分迁入） |
| `packages/agent-lab-core` | 教学核心（零依赖纯 JS，实验室专用，随 apps/agent 的 /lab 使用） |
| `packages/prism-core` | Prism 本地接口引擎（endpoints 直调/四步 smoke/CDP 探测，随 apps/cli prism 使用） |
| `packages/diffmap-core` | git 变更 treemap 引擎（提取/树布局，随 apps/agent /diffmap 与 apps/cli diffmap 使用） |
| `packages/cbmini` | C♭ 子集编译器（零依赖纯 TS，langbooks P04；完整回归需 WSL） |

## 代码规模（2026-08-30 核对）

口径：仅 `.ts` / `.tsx`（含 next.config.ts 等 TS 形态配置），**不含**测试文件、json/yaml/lock/css/md 与构建产物；`node:sqlite` 数据文件不入库。

| 目录 | 行数 |
|---|---|
| `apps/console` | 27,036 |
| `apps/blog` | 16,483 |
| `packages/ui` | 1,660 |
| `packages/inventory-core` | 1,359 |
| `packages/shared` | 1,226 |
| `apps/cli` | 101 |
| **合计** | **47,865** |

口径外参考：测试文件（ts/tsx）6,485 行；`agent-lab-core` 为纯 JS 包约 2,581 行；`apps/blog` 内容资产（技能快照/文章/题库 md+json）约 3.3 万行；`pnpm-lock.yaml` 5,277 行——以上均不计入合计。

## 验证命令

```bash
pnpm typecheck    # 全仓类型检查（TS 7）
pnpm test         # 全仓测试
pnpm build        # 全仓构建
```
