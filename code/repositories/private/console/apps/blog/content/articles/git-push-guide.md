---
slug: git-push-guide
title: "Git 推送指南整合"
series: "Agent 工具手册"
source: agent-skills
date: 2026-08-24
excerpt: "gh/GITHUB_TOKEN 401、push 保护、-force 约束等推送故障的排查与规范。"
---

# Git 推送指南整合（Canonical）

> 适用范围：skills-lab 仓库与同类私有仓推送流程。
> 目标：最短路径完成“本地提交 → 远端创建/关联 → 推送验证 → 故障排查”。

## 一 快速开始（推荐主线）

### 1) 前置检查

```bash
gh auth status
git status --short
git remote -v
```

### 2) 一条命令创建并推送（新仓）

```bash
gh repo create <repo-name> --private --source=. --remote=origin --push
```

### 3) 推送后最小验证

```bash
git remote -v
git status
git log --oneline -3
```

## 二 标准流程（从零到可推送）

### 1) 初始化与首提交流程

```bash
# 可选：先写 .gitignore
git init
git add .
git status --short
git commit -m "feat(core): 初始化项目仓库"
```

### 2) 远程创建与关联

```bash
# 推荐：一条命令
gh repo create <repo-name> --private --source=. --remote=origin --push

# 兜底：分步执行
gh repo create <repo-name> --private
git remote add origin git@github.com:<owner>/<repo-name>.git
git branch -M main
git push -u origin main
```

### 3) 既有仓库常规推送

```bash
git add .
git commit -m "feat(scope): 描述"
git push -u origin <branch>
```

## 三 GitHub 认证与 Token 管理

### 1) 推荐认证方式优先级

1. SSH Key（本地开发首选）
2. `gh auth login`（凭据存 Keychain）
3. `GITHUB_TOKEN`（仅 CI/CD）
4. PAT（临时场景，需设过期）

### 2) SSH 快速校验

```bash
ssh -T git@github.com
```

### 3) GITHUB_TOKEN 冲突处理（高频）

现象：`gh` 报 `HTTP 401` 或 `The token in GITHUB_TOKEN is invalid`。

```bash
# 当前 shell 临时清理
unset GITHUB_TOKEN

# 更稳妥：对单次命令置空
GITHUB_TOKEN= gh repo create <repo-name> --private --source=. --remote=origin --push
```

排查来源：

```bash
rg "GITHUB_TOKEN" ~/.zshrc ~/.bashrc ~/.zprofile 2>/dev/null || echo "未在 shell 配置中找到"
```

## 四 常见故障（精简版）

### 1) `gh repo create ... --push` 静默失败

```bash
gh repo create <repo-name> --private
git remote add origin git@github.com:<owner>/<repo-name>.git
git push -u origin main
```

### 2) `Permission denied (publickey)`

```bash
ssh -T git@github.com
ssh-keygen -t ed25519 -C "your_email@example.com"
gh ssh-key add ~/.ssh/id_ed25519.pub
```

### 3) `fatal: remote origin already exists`

```bash
git remote -v
git remote remove origin
git remote add origin git@github.com:<owner>/<repo-name>.git
```

### 4) 首次 commit 想重写

```bash
rm -rf .git
git init
git add .
git commit -m "新的 commit message"
git remote add origin git@github.com:<owner>/<repo-name>.git
git push -u origin main --force
```

> 警告：`--force` 只在确认无协作者时使用。

### 5) 归档仓库 push 失败

错误：`This repository was archived so it is read-only.`

处理顺序：
1. 先尝试原仓库分支推送。
2. 若失败，迁移改动到整合仓对应模块路径。
3. 在整合仓使用统一迁移分支吸收改动。
4. 合并 `main` 后做冒烟验证。

## 五 分支模型与推进（团队约定）

### 1) 分支职责

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 稳定基线 | 仅 PR 合并，禁止直推 |
| `dev` | 开发集成 | 功能分支默认合入 |
| `test` | 测试环境 | 从 `dev` 推进 |
| `sit` | 集成环境 | 从 `test` 推进 |
| `prod` | 生产环境 | 从 `main` 推进 |

推进链路：`feature/* → dev → test → sit → main → prod`

### 2) 防止误在 main 开发

```bash
git branch --show-current
git status
```

若发现未提交改动在 `main`：立即 stash/切分支迁移，不在 `main` 直接开发。

## 六 推送前检查清单（上线前 60 秒）

```bash
gh auth status
git remote -v
git status
git log --oneline -3
```

确认后再执行：

```bash
git push -u origin <branch>
```

## 七 踩坑实录（Lessons Learned）

> 以下来自实际开发过程中遇到的 Git 故障，按场景归档。

### 1) `git checkout` 被 broken symlinks 阻塞

**场景**：仓库中存在指向已删除目标的符号链接（如 `.cursor/skills/xxx → ../已删除目录`），切换分支时报 `error: The following untracked working tree files would be overwritten`。

**处理**：

```bash
# 方案 1：强制切换（慎用，会丢弃工作区变更）
git checkout -f <branch>

# 方案 2：手动清理 broken symlinks 后再切
find .cursor/skills .claude/skills -type l ! -exec test -e {} \; -delete 2>/dev/null
git checkout <branch>
```

**预防**：符号链接删除后，立即 `git add` 并提交，避免在工作区留下已删除但未 staged 的链接残留。

### 2) `git merge --no-ff` 在沙盒中无法删除受保护文件

**场景**：`--no-ff` 合并的分支包含删除符号链接的改动，合并成功但报 `warning: unable to unlink '.cursor/skills/xxx': Operation not permitted`。Git 记录了删除，但文件系统上残留 untracked 文件。

**处理**：

```bash
# 合并后手动清理残留
rm -f .cursor/skills/frontend-design .cursor/skills/pnpm ...
# 或批量清理
git clean -fd .cursor/skills/ .claude/skills/
```

**注意**：此操作需要 `required_permissions: ["all"]` 才能在 Cursor 沙盒中执行。

### 3) 已合并到 main 的提交改写（`--force-with-lease`）

**场景**：功能分支已合并到 main 且 push，但需要修正 commit message（如对齐中文提交规范）。

**完整步骤**：

```bash
# 1. 在功能分支上 amend
git checkout <feature-branch>
git commit --amend -m "新 message"

# 2. 重建 main（reset 到分叉点前）
git checkout main
git reset --hard <fork-point>

# 3. 重新 --no-ff merge（按合并顺序依次）
git merge --no-ff <branch-1> -m "chore(merge): 描述 1"
git merge --no-ff <branch-2> -m "chore(merge): 描述 2"

# 4. 安全强推
git push --force-with-lease origin main
git push --force-with-lease origin <feature-branch>

# 5. 验证：代码差异为空
git diff <old-main-hash> HEAD --name-only  # 应无输出
```

**风险**：
- **禁止**在有协作者时强推 `main`，除非所有人同意
- 改写后 **必须** `git diff` 验证代码内容与改写前完全一致
- merge commits 的 subject 如果已符合规范，**不改**

### 4) pnpm bin shim 路径错误导致命令静默失败

**场景**：仓库从旧路径迁移到新路径后，`pnpm lint/build/typecheck` exit 1 无输出。

**根因**：`pnpm install` 生成的 `node_modules/.bin/*` shim 脚本内含硬编码旧绝对路径。

**处理**：

```bash
# 确认路径不匹配
head -3 node_modules/.bin/oxlint  # 查看 basedir 指向

# 修复：重装依赖
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

**详见**：沙盒手册「故障补丁」章节有更完整的排查处方。

### 5) `git add` / `git commit` 在沙盒中静默失败

**场景**：执行 `git add .` 或 `git commit -a` 返回 exit 1，无任何输出，`git diff --cached` 确认 staged 为空。但同一仓库同一分支之前的 `git add` 操作曾经成功。

**根因**：Cursor 沙盒的 shell session 状态在某些操作后会进入"只读"模式。`git status`、`git log` 等读操作正常，但 `git add`（修改 `.git/index`）等写操作被静默阻止。即使 `required_permissions: ["all"]` 也不一定恢复。

**处理——`bash -c` 子进程绕过**：

```bash
# 关键技巧：用 bash -c 启动子进程执行 git 写操作
bash -c 'cd /abs/path && git add -A && echo "STAGED_OK" && git diff --cached --stat'

# 组合 add + commit
bash -c 'cd /abs/path && git add -A && git commit -m "commit message"'

# 推送同理
bash -c 'cd /abs/path && git push -u origin HEAD 2>&1'
```

**关键经验**：
- 如果直接 `git add` 返回 exit 1 无输出，**不要反复重试**
- 立即切换为 `bash -c '...'` 写法
- `bash -c` 子进程不受当前 shell session 状态影响
- 这与处方 G（session 损坏）不同：此时读操作正常，仅写操作失败
- 建议在两段式提交流程中，**始终用 `bash -c` 包裹 git 写操作**

### 6) 分支命名与仓库惯例对齐

**场景**：创建分支名应反映改动性质并包含日期后缀。

**本仓库约定**：

```
feat/<scope>-<描述>-YYYYMMDD     # 新功能
fix/<scope>-<描述>-YYYYMMDD      # 修复
chore/<scope>-<描述>-YYYYMMDD    # 日常维护
```

示例：
- `fix/react-practices-env-20260211`
- `chore/skills-prune-20260211`
- `feat/react-practices-audit-20260211`

## 八 两段式提交的沙盒安全写法

> 基于实际经验，在 Cursor 沙盒中执行两段式提交时，**始终用 `bash -c` 包裹所有 git 写操作**。

### 完整模板

```bash
# 提交 1：功能代码（feat / fix）
bash -c 'cd /abs/path && git add <功能文件列表> && git commit -m "feat(scope): 描述 [skills:...]"'

# 提交 2：闭环资产（chore(meta)）
bash -c 'cd /abs/path && git add -A && git commit -m "chore(meta): 回填 PRD-xxx 闭环追溯信息 [skills:...]"'

# 推送
bash -c 'cd /abs/path && git push -u origin HEAD 2>&1'

# 切换并合并
bash -c 'cd /abs/path && git checkout main && git pull --rebase 2>&1'
bash -c 'cd /abs/path && git merge --no-ff <feature-branch> -m "chore(merge): 描述" 2>&1'
bash -c 'cd /abs/path && git push 2>&1'
```

### 为什么需要 `bash -c`

| 操作 | 直接执行 | `bash -c` |
|------|----------|-----------|
| `git status` | 正常 | 正常 |
| `git log` | 正常 | 正常 |
| `git add` | 可能 exit 1 静默失败 | 正常 |
| `git commit` | 可能 exit 1 静默失败 | 正常 |
| `git push` | 需要 `["full_network"]` | 需要 `["all"]` |

## 九 提交信息规范（从历史提炼）

### 1) 本仓库风格（从历史提炼）

```text
type(scope): 中文动词开头的一句话描述

- bullet 1：具体文件/模块 + 做了什么
- bullet 2：具体文件/模块 + 做了什么
- bullet 3：结论/确认项（如有）

[skills:skill1,skill2]

Co-authored-by: Cursor <cursoragent@cursor.com>
```

### 2) 风格要点

| 维度 | 规律 |
|------|------|
| subject 语言 | 全部中文，scope 后冒号跟中文动词 |
| subject 格式 | `type(scope): 中文动词开头的一句话` |
| body 格式 | 中文 bullet 列表（`- xxx`），每行独立描述一个改动点 |
| skills 标签 | Cursor Agent 提交带 `[skills:xxx,yyy]` 尾标签，手动提交可省略 |
| Co-authored-by | Cursor Agent 提交**统一带** `Co-authored-by: Cursor <cursoragent@cursor.com>` |
| merge commits | `chore(merge): 中文描述`，body 通常为空 |
| 破折号 | 使用中文标点 `，` `、`，不使用英文 em dash `—` |

### 3) 两段式提交模式

当一次任务包含代码改动 + evidence 文档时，拆成两笔提交：

```bash
# 提交 1：代码与配置修复
git add <源码文件> <配置文件>
git commit   # type: feat / fix

# 提交 2：evidence 与流程产物
git add .ggbdpq/artifacts/evidence/
git commit   # type: chore(meta)
```

## 十 PR-Agent（简版指引）

本仓库启用 `qodo-ai/pr-agent`，通过 PR 事件触发自动审查。

- Workflow：`.github/workflows/pr-agent.yml`
- 配置：`.pr_agent.toml`
- 常用评论命令：`/review`、`/describe`、`/improve`、`/help`

> 详细 PRD 闭环与回填流程属于执行法典范畴，统一以 `.ggbdpq/actions/EXECUTION.md` 与 `.ggbdpq/actions/prd.json` 为准。

---

最后更新：2026-02-12（新增 git add 沙盒静默失败处方 + bash -c 两段式提交安全写法）
