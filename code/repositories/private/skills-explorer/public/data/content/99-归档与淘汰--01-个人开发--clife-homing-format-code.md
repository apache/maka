---
name: clife-homing-format-code
description: Use when changed files in beauty-smart-advisor need scoped Prettier/ESLint import sorting, git diff whitespace checks, staged snapshot refresh, SCSS Stylelint decisions, or pre-commit formatting without whole-repo churn.
---

# Clife Homing 改动文件格式化

核心：只处理 Git 已改文件，减少无关 diff。脚本已随 skill 放在 `scripts/format-changed.cjs`，从任意子目录运行时会向上定位项目根目录。

## 首选命令

从仓库内任意目录运行：

```powershell
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs"
```

常用变体：

```powershell
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs" --check
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs" --staged
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs" --no-untracked
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs" --no-eslint
node "$env:USERPROFILE\.agents\skills\clife-homing-format-code\scripts\format-changed.cjs" --typecheck
```

## 选择规则

| 场景                       | 命令             | 说明                                                            |
| -------------------------- | ---------------- | --------------------------------------------------------------- |
| 改完代码，需要写入格式化   | 默认命令         | Prettier 写入、ESLint autofix/import sort、空白检查             |
| 提交前只读检查             | `--check`        | 不写文件，检查工作区和暂存快照是否一致                          |
| 用户只让处理暂存区         | `--staged`       | 排除未跟踪和未暂存文件                                          |
| 脏工作区里有无关未跟踪文件 | `--no-untracked` | 避免把临时文件带入格式化                                        |
| Node 24 / ESLint 插件阻断  | `--no-eslint`    | 只跑 Prettier 和 `git diff --check`，交付时说明 import 排序未跑 |
| 需要类型检查               | `--typecheck`    | 额外执行 `tsc --noEmit --pretty false`                          |

脚本会自动刷新“运行前已暂存且没有未暂存改动”的文件快照；如果某个暂存文件同时有未暂存改动，脚本会停下并列出文件，后续由人工决定 `git add` 范围。

## 脚本覆盖范围

- 变更集合：`git diff --cached` + `git diff` + 未跟踪文件；`--staged` 时只取暂存区。
- Prettier：`.js .cjs .mjs .jsx .ts .tsx .scss .css .less .json .md .yml .yaml`。
- ESLint：`.js .jsx .ts .tsx`，包含 `simple-import-sort` 导入/导出排序。
- 收尾：`git diff --check -- <files>` 和 `git diff --cached --check -- <staged-files>`。

需要解释项目格式契约、修改脚本或排查工具链失败时，读 [references/project-format-contract.md](references/project-format-contract.md)。普通格式化只用本页命令。

## SCSS 决策

`format-changed.cjs` 对 SCSS 只跑 Prettier。涉及属性顺序或用户点名 Stylelint 时，再单独跑：

```powershell
npm run lint:style
npx stylelint "src/pages/serviceComplete/**/*.scss" --fix
```

`order/properties-order` 当前只在 `src/pages/reservationBoard/**/*.scss` 强制；其它目录手写时按同一顺序保持 diff 稳定。

## 高价值反模式

| 反模式                                               | 代价                            | 正确做法                                        |
| ---------------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| 用 `npm run format` / `yarn prettier` 处理本轮小改动 | 会重排大量无关文件              | 用 skill-local `format-changed.cjs`             |
| 在脏工作区里 `git add .`                             | 混入用户未确认改动              | 只按脚本列出的目标文件/用户白名单操作           |
| 暂存文件有未暂存改动时强行 restage                   | 破坏用户的 staged/worktree 切分 | 让脚本报出阻断文件，再人工选择                  |
| 把 Stylelint 属性排序塞进默认脚本                    | 可能扩大 SCSS diff              | 只在 SCSS 任务需要时单独跑                      |
| 工具缺失时改成全局二进制                             | 结果受机器环境影响              | 使用项目本地 `node_modules`，缺失就报告真实错误 |

## 交付格式

交付时报告：运行路径、命令、exit code、处理文件数、是否跳过 ESLint/Stylelint/typecheck、最终 `git status --short` 或关键 diff 范围。
