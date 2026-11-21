# Skills Explorer

本机 `~/.ai/categories` 技能库的可视化目录站：**1697 个技能**的搜索、详情阅读、统计与收藏。纯静态 SPA（构建时索引，无需后端），Vue 3 + TypeScript 7 + Vite 8 + Tailwind CSS 4 + shadcn-vue。

## 快速开始

```bash
pnpm install
pnpm dev        # 开发：http://localhost:5173
pnpm index      # .ai 技能库变更后重建站点数据（public/data/）
pnpm test       # 索引 CLI 与已发布分类键回归
pnpm build      # 生产构建（dist/）
pnpm typecheck  # TS7 原生 tsc（.ts 逻辑层）
```

索引默认读取当前用户的 `~/.ai/categories`，可用 `SKILLS_CATEGORIES` 指定其他来源。
分类键固定使用 `/`，与浏览筛选和分享 URL 保持一致；文件读写仍使用系统路径。
来源少于 300 个技能时退出失败并保留旧索引与正文；通过检查后的磁盘写入不保证全目录事务。

## 架构

```
~/.ai/categories（技能 SSOT，纯合集）
        │  pnpm index（scripts/build-index.mjs，栈式递归 + 扁平安全 id + 质量护栏）
        ▼
public/data/index.json（元数据）+ content/*.md（正文懒加载）
        │  Axios + Zod 校验
        ▼
Vue SPA：浏览（搜索/区域/分类 chips/排序/加载更多）· 详情（事实卡 + markdown）· 统计 · 收藏
```

- `.ai` 只存技能正文与视图清单（`skills.manifest.json`）；工具链已于 2026-10-24 迁回 `~/.ai/scripts`（管线本为 .ai 服务），本仓库保留站点与文档。
- 视图层：`~/.agents/skills` junction 农场 → 15 个 CLI 目录，由 `~/.ai/scripts/sk-sync.js` / `sk-rebuild.js` 管理。

## scripts/ — 技能管线（2026-10-24 已迁至 `~/.ai/scripts`，下表为历史用途参考）

`pnpm index` / `pnpm test` 已改为调用 `../../scripts/` 下的同名脚本，行为不变。

| 脚本                             | 用途                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `update-skills.js`               | 五步更新管线：`npx skills update` 拉上游 → robocopy 进真身 → rebuild → sync → doctor 复核。`--register` 注册每 15 天任务计划 |
| `sk-rebuild.js`                  | 按 manifest 重建 `~/.agents/skills` 视图（实体自动备份到 `.ai/.removed-<时间戳>/`）                                          |
| `sk-sync.js`                     | 把视图镜像到 15 个 CLI 目录 + Codex 原生技能                                                                                 |
| `sk-doctor.js`                   | SSOT 体检（断链/绕源/撞名/frontmatter），problems 基线 49 为既有                                                             |
| `sk-lock.js` / `sk-lock-slim.js` | `.agents/.skill-lock.json` 锁文件管理                                                                                        |
| `build-index.mjs`                | 本站索引生成（栈式递归、扁平安全 id、数量/空描述护栏）                                                                       |

## 目录

- `docs/` — 方法文档、使用手册、外部技能研究、架构分析、批量收录台账（`skills-batch-*.json`）
- `logs/` — 更新管线日志（gitignore）
- `BUGS.md` — bug 台账；`.ggbdpq/` — 治理工件（prd.json + progress.txt）

## 已知约束

- TypeScript 7（Go 原生编译器）下 vue-tsc 3.x 不兼容，typecheck 覆盖 .ts 逻辑层，.vue SFC 内部检查待生态适配（见 `.ggbdpq/actions/skills-explorer/prd.json` item 10）。
- rolldown-vite 编译 SFC 无跨文件类型解析所需 fs：6 个 shadcn-vue 生成组件的 defineProps 外部类型已内联（文件内有注释）。
