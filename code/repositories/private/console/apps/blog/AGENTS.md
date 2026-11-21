# blog —— 个人博客微服务

## 项目定位

vibe 体系内的个人博客微服务（`apps/blog`，端口 65502）：以 `inbox/ggbdpq-site` 为核心，把 ghost-lab、agent-todo（文档）、date-playbook-miniapp（Web 化）、agent-skills、product-blueprint（宪法）、spec-kit-me（脱敏一篇）九个散落项目的内容并入一个统一栈应用。

## 技术栈宪法（禁改区）

- React 19 + TypeScript 7 + PNPM 11 + Next.js（App Router）+ Zustand + fetch + Zod 4 + Tailwind CSS 4 + shadcn/ui + node:sqlite
- 单进程：全部后端能力运行在本服务 Next.js 的 Node runtime 内
- 不引入：React Router、NestJS、Prisma、PostgreSQL、Go、Tauri、第二个前端框架

## 架构边界（违反即架构腐化）

1. **API 层唯一入口**：`src/app/api/**`。客户端只经 HTTP fetch 访问后端，禁止直接 import 服务端模块。
2. **数据域深模块**：文章域 `src/server/articles.ts`、题库 `src/server/problems.ts`、约会攻略 `src/server/date-playbook/venues.ts`、技能 `src/server/skills.ts` 是各自数据的唯一入口；页面与 RSS 只经它们取数，不感知数据源差异（TS 内联 / md 文件 / sqlite）。
3. **数据落盘**：node:sqlite 库文件落 `data/`（gitignore），`BLOG_DATA_DIR` 供测试隔离；repo 工厂接受 db 注入（`:memory:` 可全链路测试）。
4. **schema 单一真相**：出入参 Zod schema 一律放 `src/schemas/`，前后端从同一 schema 推导类型。
5. **UI**：复用 workspace 定制层 `@ggbdpq/console-ui`，页面不直接堆 radix 原语；博客自有组件（moment-card 等）放 `src/components/`。

## 内容资产约定

- `content/articles/*.md`：迁移文章，frontmatter（slug/title/series/source/date/excerpt）由 `scripts/migrate-content.mjs` 注入；slug 必须 ASCII。
- `content/problems/*.json`：题目库；`content/skills/*/SKILL.md`：技能卡；`public/anime/`：分层图。
- TS 内联文章在 `src/data/articles.ts`，与 md 双源统一进文章域模块。
- **隐私红线**：不得迁入 date-playbook 的 archive.private.seed.ts、spec-kit 的 rigor 篇等职场资料；新增迁移先过脱敏检查。

## 验证命令

```bash
pnpm dev:blog            # 端口 65502
pnpm --filter @ggbdpq/blog run typecheck
pnpm --filter @ggbdpq/blog run test
pnpm --filter @ggbdpq/blog run build
```

## 治理闭环

需求 → `.ggbdpq/actions/blog/prd.json` → 执行第一个未完成事项 → typecheck / test → `.ggbdpq/progress.txt` → commit。

## 迁移对照表（九项目 → blog）

**2026-08-30 起三源项目已删除**（ggbdpq-site / date-playbook-miniapp / ui，核心内容核验迁移完成后 `git rm`，全部文件在 git 历史可恢复；date-playbook 私人种子移 `inbox/_archive-private` 保护区）。product-blueprint / spec-kit-me / agent-skills 的治理配置统一收至 `../../.ggbdpq/sources/`（SSOT），**三项目本体亦于同日删除**（整合核验后 `git rm`，历史可恢复；agent-skills 在 GitHub 独立存续）。

| 来源 | 去向 | 方式 |
|---|---|---|
| ~~inbox/ggbdpq-site~~（已删，历史可恢复） | 博客本体 | 内容资产 + 六大 feature 区（daily/database/forum/admin/resume/judge）+ forum 视图层全量 verbatim；rss/sitemap 重建 |
| ~~inbox/ghost-lab~~（用户手动删除 2026-08-30） | 系列「AI 工程实践」 | 15 篇(视频精华×14 + 心得×1)已在 blog 随 git 存续；zip/backup 在 git 历史可恢复 |
| inbox/agent-todo（**保留**） | 系列「Agent Todo 设计笔记」 | docs 7 篇转 md；**应用代码未迁**（Fastify 七步流水线/审批流/SQLite 层），本体留 inbox 作参考实现 |
| ~~inbox/chat-viewer~~（2026-08-30 全量移植，达删除条件） | `/chat-viewer` | Next.js 同构：viewer/workbench/ui + lib 九域全量拷贝(5.5k 行)；本地优先(IndexedDB+OCR 客户端)；源仓库 docs 随迁 feature 内 |
| ~~inbox/skillbase~~（2026-08-30 全量移植，达删除条件） | `/skill-manager` | SPA 9 组件+api 拷贝；ops-server/generate-data 收编为同源路由；数据根适配 `~/.ai`；隐私种子移 `.ggbdpq/sources/date-playbook/`(gitignore 保护) |
| ~~inbox/date-playbook-miniapp~~（已删，历史可恢复） | `/date-playbook` | 领域逻辑字节级拷贝 + 12 页 Web 化（计划全生命周期/复盘/九阶段/家庭树/回忆/档案）；**private 种子禁迁**，已移保护区 |
| ~~inbox/agent-skills~~（已删，历史可恢复；GitHub 独立存续） | `/skills` + 文章 | 3 个 curated 技能卡(21 文件全包)迁入；两份运维手册收录为「Agent 工具手册」×2；配置收至 `.ggbdpq/sources/agent-skills/` |
| ~~inbox/product-blueprint~~（已删，历史可恢复） | 系列「知识库宪法」 | 3 篇宪法转 md；治理配置 + config/ 收至 `.ggbdpq/sources/product-blueprint/` |
| ~~inbox/spec-kit-me~~（已删，历史可恢复） | 系列「Spec 工作法」 | 仅骨架标题 1 篇，产品功能名脱敏；rigor 篇含职场信息不迁；配置收至 `.ggbdpq/sources/spec-kit-me/` |
| inbox/skillbase | —（不迁代码） | 强依赖本机 ~/.agents，定位由技能目录页承接；原地归档 |
| ~~inbox/ui~~（已删，历史可恢复） | workspace UI 层 | 组件库本体不迁（shineout/storybook 违反栈宪法）；`@ggbdpq/console-ui` 46 组件按 ant-design 清单新建，源库作参考件留于 git 历史 |
