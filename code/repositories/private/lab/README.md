# lab — 实验区

- **`console/`** — 个人综合大仓（pnpm monorepo，独立 git 无远程）：
  - `apps/` 7 个 Next.js 应用：console 运维控制台(65501) · blog 博客(65502) · toolbox 工具箱(65503) · agent AI Agent 线(65504，含配置/治理/实验室/执行引擎/Worktree/技能管理/课程/面试自练场/变更审查/RuoYi AI 知识库/下载台) · admin 若依形制管理后台(65505，liliya 的 Node 重写) · portal 门户(65515) · cli 统一命令行
  - `packages/` 10 个核心包（inventory/toolkit/register/diffmap/prism/cbmini/shared/ui 等），`apps/cli` 复用同批包
  - 后端统一 Next API Routes + Node 24 内置 node:sqlite，无独立服务进程；入口 `console/README.md` 与各应用 README
  - `archive/` 内含已退役源仓快照（cbmini/diffmap/interview-gym/linkpull/prismctl）与 agents-console-monorepo 历史备份
- **`skills-explorer/`** — `~/.ai` 技能库可视化目录站（静态 SPA）
- `47.116.78.77/`、`chrome/`、`ai-native-handbook.pdf` — 服务器/浏览器扩展资料等非项目杂项

## 已退役（2026-10-25 收编 console 后删除）

ruoyi-ai-web（→ apps/agent `/ruoyi-ai`）、linkpull（→ apps/agent 下载台）、cbmini/diffmap/interview-gym/prismctl 独立仓（→ packages 与 agent 功能台）、liliya Go 版（→ apps/admin Node 重写；其历史 bundle 在 `console/apps/admin/docs/liliya-go-history.bundle`）。
