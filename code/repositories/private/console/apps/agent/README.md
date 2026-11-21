# @ggbdpq/agent

AI Agent 线一站式工作台（端口 65504）：从控制台（65501）与工具箱（65503）收拢的 AI agent 相关模块。2026-09-19 由 AI 线收拢迁移建立，模块代码原样搬移（git mv，零改动）。

## 功能台

- **配置台** `/agentops`：编辑器配置扫描、计划、备份、回滚 + cc（Claude Code）配置全家桶（来源：config-engine）
- **治理台** `/governance`：prd.json / progress.txt / Git 三向联查，七视图（来源：governance）
- **实验室** `/lab`：浏览器活跑 coding agent，23 关教学走读（来源：pi-web-dev，核心 JS 在 `packages/agent-lab-core`）
- **执行引擎** `/workflow`：Agent 任务列表、创建与执行状态实时刷新（SSE + 轮询兜底）
- **Worktree 台** `/worktree`：项目注册 + Agent（worktree）生命周期管理（来源：ai-worktree-commander）
- **技能管理** `/skill-manager`：`~/.ai` 中央技能库实时扫描/全局切换/运维面板（来源：skillbase；env `SKILL_MANAGER_ROOT` 可覆盖数据根）
- **课程** `/course`：「理解大模型 · 从 Token 到 Agent」16 课交互课程（来源：token2agent；样式作用域化 `.course-root`）
- **面试自练场** `/interview-gym`：闭卷题库、项目口述与模拟面试；资料唯一事实源为 [interview](../../../../interview/study/README.md)（2026-10-03 自独立应用并入）
- **变更审查** `/diffmap`：按文件内容指纹保留审查标记；内容变化或无法证明未变时重新审查。报告提取期间消失的文件保留条目，不复用旧标记。
- **RuoYi AI 知识库** `/ruoyi-ai`：纯前端 RAG 全链路（分片→向量→检索→回答，IndexedDB + transformers.js 本地向量模型，无后端能力；2026-10-25 自 lab/ruoyi-ai-web verbatim 并入，MemoryRouter 承载内部路由，主题 token 作用域 `.ruoyi-ai-root`）
- **下载台** `/downloads`：URL → yt-dlp 下载（B站/YouTube/X，任务态轮询 + 日志查看；2026-10-25 自 lab/linkpull/Go 承接——下载引擎不自研，spawn yt-dlp 生态，产物落 `~/Downloads/agent-downloads`，env `AGENT_DOWNLOADS_DIR` 可覆盖）
- **幻灯片** `/deck`：「如何 Harness 我的大模型」23 页演讲稿（来源：harness-deck；fixed 全屏舞台，返回键退出）

> 课程与幻灯片内容版权归原作者所有，仅供个人本地学习，勿公开部署或传播。

## 架构

与控制台同构：React 19 + Next.js（App Router）+ TypeScript 7 + Tailwind CSS 4 + `@ggbdpq/console-ui`（shell/组件定制层）+ `node:sqlite`（数据落 `data/`，gitignored）。API 唯一入口 `src/app/api/**`；常驻任务注册在 `src/instrumentation.ts` → `src/runtime/tasks.ts`（governance 文件监听 + cc 配置监听），幂等可重启。

## 启动与验证

```bash
# 仓库根（pnpm workspace）
pnpm install
pnpm dev:agent      # http://localhost:65504
pnpm --filter @ggbdpq/agent run test      # Vitest 单测
pnpm --filter @ggbdpq/agent run typecheck # 类型检查
pnpm --filter @ggbdpq/agent run test:e2e  # Playwright e2e
```

## 面试资料同步

`dev`、`build`、`test` 会先运行 `sync-content`。默认源为`cc/guahub/interview/study`；可用 `INTERVIEW_DOCS_DIR` 指定其他根目录。手动同步：

```bash
pnpm --filter @ggbdpq/agent sync-content
```

当前导入 17 份正文：4 份题库、1 份合并模拟说明、9 份 AI 项目资料和 3 份公开项目叙事。F/A/S 编号共 22 题，回答骨架、案例、失败追问和深挖正文完整保留。项目地图提供 9 张口述卡，其中 3 张连接公开叙事的 5—8 分钟版本。五个既有模拟入口共用合并说明，不再依赖已精简的候选题库或五份旧模拟卷。

全部必需来源检查通过后才替换 `public/interview-gym/content/`；缺目录或目录无匹配正文时退出，保留上次副本。内容更新后刷新页面读取新快照。

既有每日配比与模拟计时配额沿用原配置；当前复习顺序以 interview 项目地图为准（P04/P02 主讲，P05 备用）。没有独立题目的编码入口展示手练说明，不启动空考试或记录成绩。旧练习的题目 ID 不重映射；已移除题目可跳过继续，历史成绩保留。
