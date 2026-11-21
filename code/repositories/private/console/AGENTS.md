# console —— 个人 Agent 统一控制台

## 项目定位

本仓库是 vibe 体系内一期合并工程的产物：把 card-admin、tokens-toolkit、config-engine、governance、pi-web-dev 五个同构本地工具收敛为**一个 Next.js 单进程控制台**。二期迁入 promptflow、workflow-engine（降栈）与 worktree 台（Web 化重写）。**2026-09-19 起 AI agent 相关模块（配置台/治理台/实验室/执行引擎/Worktree 台/技能管理）拆出为 `apps/agent`（65504），与控制台同栈同构**，见文末「四期：AI 线收拢」。

## 技术栈宪法（禁改区）

- React 19 + TypeScript 7 + PNPM 12 + Next.js（App Router）+ Zustand + fetch + Zod 4 + Tailwind CSS 4 + shadcn/ui + node:sqlite
- 各 Web 应用的后端能力运行在自身 Next.js 的 Node runtime 内；同一应用不另起服务进程。工作区多应用可以按各自端口并行启动。
- 不引入：React Router（Next 文件路由取代）、NestJS、Prisma、PostgreSQL、Go、Tauri、第二个前端框架

## 架构边界（违反即架构腐化）

1. **API 入口随应用归属**：各 Web 应用的 `src/app/api/**`。浏览器通过 HTTP fetch 访问后端，禁止 import Node 业务模块；Node CLI 可复用 `packages/*` 明确导出的领域 API，不直接 import 各应用的私有 `src/server/**`。CLI 的服务探测等远程能力仍走 HTTP。
2. **常驻任务唯一入口**：各 app 的 `src/instrumentation.ts` → `src/runtime/tasks.ts` 注册表（当前仅 apps/agent 有常驻任务）。文件监听、worker 循环、批量刷新必须在此注册，且必须幂等可重启（对冲 dev 热重载）。
3. **数据**：`node:sqlite` 文件落各 app 的 `data/` 目录（仓库级 gitignore `/apps/*/data/`）。各域各库，不跨域写表。
4. **共享类型**：跨前后端的 Zod schema 一律放 `packages/shared`，前后端从同一 schema 推导类型。
5. **UI 定制**：shadcn 组件定制层放 `packages/ui`，页面内不直接堆 radix 原语。
6. **UI 风格**：颜色/字体/圆角一律走语义 token（唯一住址 `packages/ui/src/styles/base.css`），禁止裸色名工具类。规范全文见 `docs/design/DESIGN.md`，机械检查 `pnpm style:check`。

## 模块豁免规则

`packages/agent-lab-core` 是 pi-web-dev 迁入的教学核心：**保持零依赖纯 JS，禁止 TS 化、禁止加依赖、禁止改写风格**——那是它的教学价值。唯一允许的变更是修 bug。

**Verbatim 移植豁免边界**：按原版全量移植的模块（agent-lab-core、chat-viewer、skill-manager 等），豁免仅覆盖 lib/components 等**源码本身**；上一仓库的元文件（README、LICENSE、CI workflow、CONTRIBUTING、样本数据、开发档案）不属保真范围，一律不随迁（2026-08-30 已清理 chat-viewer 五件套）。隐私承诺等产品声明以 app 级 README 与页面内文案为准，不以 feature 目录内的仓库文档为准。

## 验证命令

```bash
pnpm dev          # 并行启动各应用（65515 / 65501 / 65502 / 65503 / 65504）
pnpm typecheck    # 全仓类型检查
pnpm test         # 全仓测试
pnpm cli          # CLI 入口
```

## 治理闭环

需求 → `.ggbdpq/actions/console/prd.json` → 执行第一个未完成事项 → `pnpm typecheck && pnpm test && pnpm style:check` → `.ggbdpq/progress.txt` → commit。

## 迁移来源对照（一期）

| 模块 | 路由 | 来源 |
|---|---|---|
| 资产台 | `/assets` | `vibe/inbox/card-admin` |
| 库存台 | `/inventory` | `vibe/inbox/tokens-toolkit`（CLI → `apps/cli`） |
| 配置台 | `/agentops` | `agent-suite/apps/cc-profile/modules/config-engine` |
| 治理台 | `/governance` | `agent-suite/apps/promptflow/modules/governance`（解析逻辑后端化） |
| 实验室 | `/lab` | `vibe/inbox/pi-web-dev`（核心 JS → `packages/agent-lab-core`） |

## 迁移来源对照（三期：guahub 收编）

| 模块 | 路由 | 来源 |
|---|---|---|
| 注册台 | `/register` | `guahub/gpt-free-register`（引擎 → `packages/register-core`，mail-sdk → `packages/mail-sdk`；CLI → `apps/cli register`；better-sqlite3 降栈 node:sqlite） |
| 工具集 | `/toolkit` | `guahub/registration-toolkit`（去重后独有内容：k12 数据视图；batch-email → `packages/toolkit-core` + `apps/cli toolkit`） |
| 清单台 | `/todo` | `guahub/agent-todo`（Fastify → Next route handler 单进程；contracts → `packages/shared/todo` 子路径导出） |

三期补充约定：
- 两个注册仓库的文档与历史残渣（temp/backup/archive/convert/output、k12 原始脚本、fkuflash Python labs）按 verbatim 存入 `archive/`（gitignore，含真实凭证永不入库）；活跃代码与数据只取去重后的部分。
- **源仓库已删除**（2026-08-31）：三项目删除前的完整 verbatim 快照在 `archive/snapshot-final/`，找回任何历史内容以它为准。
- 真实凭证数据统一落 `apps/console/data/{register,toolkit}/`（gitignored）；API key 一律环境变量（`OUTLOOK007_API_KEY`、`DEEPSEEK_API_KEY` → `.env.local`，模板见 `apps/console/.env.example`）。
- 注册引擎的静态配置（i18n/selectors）按包位置解析；`packages/todo` 域共享 schema 走 `@ggbdpq/console-shared/todo` 子路径（规避与 agentops 的 ApiError 同名冲突）。

## 迁移来源对照（四期：AI 线收拢，2026-09-19）

AI agent 相关模块从 65501/65503 整体 `git mv` 收拢到 `apps/agent`（65504），模块代码零改动：

| 模块 | 新路由 | 原位置 | 来源 |
|---|---|---|---|
| 配置台（含 cc 全家桶） | `apps/agent /agentops` | `apps/console /agentops` + `server/agentops` + cc 组件/hooks/stores | config-engine |
| 治理台 | `apps/agent /governance` | `apps/console /governance` + `server/governance` | promptflow governance |
| 实验室 | `apps/agent /lab` | `apps/console /lab`（lab 主题 CSS 随迁 agent globals.css） | pi-web-dev（核心仍在 `packages/agent-lab-core`） |
| 执行引擎 | `apps/agent /workflow` | `apps/console /workflow` + `server/workflow` | workflow-engine 降栈 |
| Worktree 台 | `apps/agent /worktree` | `apps/console /worktree` + `server/worktree` | ai-worktree-commander |
| 技能管理 | `apps/agent /skill-manager` | `apps/toolbox /skill-manager` + features/skill-manager | skillbase |

四期补充约定：
- 常驻任务随域迁移：`apps/agent/src/instrumentation.ts` → `runtime/tasks.ts`（governance 监听 + cc 监听）；console 侧任务注册表已随迁删除，console 未来新增常驻任务时按宪法重建。
- 不迁清单（主体非 AI agent 能力，原地保留）：toolbox 的 chat-viewer（微信聊天查看+OCR）、daily（AI 主题离线演示）、console 的 practice（git 提交看板）、bookmarks（书签管理）。
- `packages/agent-lab-core` 保留在 packages 层不随迁（包层为共享基础设施，与 inventory-core 同理；仅 apps/agent 消费）。
- 数据目录沿用仓库级 gitignore `/apps/*/data/`（`apps/agent/data/` 已覆盖）；workflow.db 等本地数据已手工搬至新目录，env `CONSOLE_DATA_DIR` 名称不变。
- `scripts/check-style.mjs` 的豁免前缀已同步新路径（apps/agent 的 lab 与 skill-manager）。

## 迁移来源对照（五期：课程与幻灯片并入，2026-09-19）

`vibe/apps/token2agent` 与 `vibe/apps/harness-deck` 两个 Vite 独立应用 verbatim 并入 `apps/agent`（同 skill-manager 先例）：

| 模块 | 新路由 | 源 | 说明 |
|---|---|---|---|
| 交互课程 | `apps/agent /course` | token2agent/src → `features/course/` | 「理解大模型 · 从 Token 到 Agent」16 课；入口 createRoot 由 `dynamic(ssr:false)` 适配层取代，其余零改动 |
| 演讲幻灯片 | `apps/agent /deck` | harness-deck/src → `features/deck/` | 23 页；`.deck` 是 fixed 全屏舞台，CSS 原样随迁，进入即整屏接管 |

五期补充约定：
- course 的 index.css 含原站 Tailwind 主题与 `:root/body` 全局规则，已做机械作用域化（全部规则限定 `.course-root` 子树，`:root/html/body → .course-root`，@keyframes 不动）；转换后与源站编译产物 `47.116.78.77/home/assets/index-D_phTh1N.css` 做过规则序列比对，1436 条 100% 一致。
- `features/course/visuals.tsx` 为反编译还原源码（原项目 `noImplicitAny:false`），整文件 `@ts-nocheck` 豁免，禁手同 agent-lab-core。
- 三源目录（token2agent / harness-deck / 47.116.78.77 镜像）已于并入后删除：2 张 PNG 在 `apps/agent/public/`（deck 按根路径引用）；镜像 bundle 与原始文稿（含 pptx）可从基线快照 `2cfeb2ab0` 整体找回；版权约束不变，勿公开部署。
- 版权约束：课程与幻灯片内容版权归原作者，仅供个人本地学习，勿公开部署或对外暴露（portal 不加磁贴）。

## 迁移来源对照（六期：GitHub 仓收敛，2026-10-03）

GitHub 上 5 个零依赖的小仓并入本仓，远端仓删除、verbatim 快照（含 .git）存 `archive/snapshot-final/`（gitignored，删仓后唯一恢复源）：

| 模块 | 去处 | 源 | 说明 |
|---|---|---|---|
| C♭ 编译器 | `packages/cbmini` | `ggbdpq/lang/cbmini` | verbatim（src/tests/scripts）；零依赖纯 TS，node type-stripping 直跑，不接 tsc（同 agent-lab-core 形态）；完整回归 `sh check.sh` 需 WSL（Mac 只验编译半程） |
| Prism 接口台 | `packages/prism-core` + `apps/cli prism` | `E-cc-ggbdpq-agents-prismctl` | 引擎（endpoints/http/smoke/browser-probe）进包，CLI 挂 apps/cli；bun 运行时退役，测试 vitest 化（13 用例） |
| 变更 treemap 审查 | `packages/diffmap-core` + `apps/agent /diffmap` + `apps/cli diffmap` | `ggbdpq/diffmap` | server.ts 由 route handler 取代（单进程）；CLI 语义改为定位仓库+打开带参 URL；包内相对导入用 `.ts` 后缀（Turbopack/tsx/tsc/Node 五方通吃）；浏览器侧走 `@ggbdpq/diffmap-core/web` 子路径隔离 node 依赖 |
| 面试自练场 | `apps/agent /interview-gym/**` | `ggbdpq/interview-gym` | react-router 经 `features/interview-gym/router.tsx` 适配层换 App Router（18 条路由、base 前缀、参数解码）；content 管线 Vite glob → `apps/agent/public/interview-gym/` + manifest.json 运行时 fetch（`INTERVIEW_DOCS_DIR` 覆盖，默认 `~/cc/code/paused/interview`，真相源仍是 interview 仓）；proxy.mjs(8787) → `/api/interview-gym/relay`（单进程） |
| 链接/视频拉取 | `archive/snapshot-final/linkpull` | `E-cc-ggbdpq-tools-workflow-linkpull` | Go 栈撞宪法（禁 Go + 禁第二服务进程），按三期先例纯快照不接构建 |

六期补充约定：
- 包内相对导入一律 `.ts` 后缀 + `allowImportingTsExtensions`（NodeNext/tsc、tsx、vitest、Node type-stripping、Turbopack 五方通吃）；消费方 tsconfig 需带同款开关。新包进 Next 应用时，浏览器侧导入一律走 `/web` 式子路径，防 node 内建模块混入客户端 chunk（Turbopack 会 panic）。
- verbatim 特性沿用 check-style 豁免区：interview-gym、diffmap 已进 `EXEMPT_PREFIXES`；gym 的 shadcn 主题块丢弃、直接吃 console-ui 基座令牌（ADR-0001），其组件 ui/ 短期与 packages/ui 重复，去重列为路线图欠债。
- gym 主题不再写 `<html class>`（污染全局），`.dark` 落在 `.interview-gym-root` 特性根上；内容管线产物 gitignore（`/apps/agent/public/interview-gym/`）。
- heatmap 测试原断言 `length % 7 === 0` 仅周日为真（周一为首格、截到今天），已改为「首格是周一 + 末格是今天」两条不变量。
- 源仓快照与删除：五仓工作区现状（含 diffmap 脏区）已快照；远端仓删除动作见 `.ggbdpq/progress.txt` 对应条目。
