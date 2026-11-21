# @ggbdpq/console

个人运维控制台：把资产、库存、注册、工具集、清单、书签、实践等个人运维场景收敛为一个 Next.js 单进程应用。AI agent 相关模块（配置/治理/实验室/执行引擎/Worktree/技能管理）已于 2026-09-19 拆往 `apps/agent`（65504）。

## 特性

- **七个功能台**：资产台 `/assets`、库存台 `/inventory`、注册台 `/register`、工具集 `/toolkit`、清单台 `/todo`、书签台 `/bookmarks`、实践台 `/practice`
- **单进程架构**：全部后端能力运行在 Next.js Node runtime 内，无第二服务进程
- **暗黑模式**：全站语义 token + 一键切换（`packages/ui` ThemeToggle）

## 技术栈

React 19 + Next.js（App Router）+ TypeScript 7 + Tailwind CSS 4 + shadcn/ui（`packages/ui` 定制层）+ Zustand + Zod 4（schema 见 `packages/shared`）+ `node:sqlite`（数据落 `data/`，gitignored）+ Vitest + Playwright。

架构边界与技术栈宪法见仓库根 [AGENTS.md](../../AGENTS.md)：前端与 CLI 一律经 `/api/**` HTTP 契约访问后端，禁止客户端直接 import 服务端模块。

## 启动与验证

```bash
# 仓库根（pnpm workspace）
pnpm install
pnpm dev:console    # http://localhost:65501
pnpm --filter @ggbdpq/console run test      # Vitest 单测
pnpm --filter @ggbdpq/console run typecheck # 类型检查
pnpm --filter @ggbdpq/console run test:e2e  # Playwright e2e
```

## 目录结构

```
src/
├── app/            # 路由与 API（App Router；/api/** 为后端唯一入口）
├── server/         # 服务端业务模块（按域分目录：assets/inventory/todo/...）
├── hooks/          # 客户端数据 Hook
├── components/     # 页面组件
├── stores/         # Zustand 状态
├── lib/ data/ types/
tests/              # Vitest（按域：assets/inventory/todo/...）
e2e/                # Playwright 冒烟
data/               # node:sqlite 数据文件（gitignored）
screenshots/        # 页面验收截图
```
