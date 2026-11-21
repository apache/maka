---
slug: cursor-sandbox-playbook
title: "Cursor 沙盒执行手册"
series: "Agent 工具手册"
source: agent-skills
date: 2026-08-24
excerpt: "Cursor Agent 沙盒规则的 Canonical 入口：加载路径、执行边界与推送约束。"
---

# Cursor 沙盒执行手册（Canonical Rule）

> Canonical 路径：`.cursor/rules/Cursor沙盒执行手册.md`
> 本文件是 Cursor Agent 加载的唯一沙盒规则入口。

## 一 Canonical 声明

仓库内所有对 Cursor 沙盒规则的引用，**必须**指向：

```
.cursor/rules/Cursor沙盒执行手册.md
```

其他位置只允许引用该路径，**禁止**复制第二份沙盒 playbook。

## 二 沙盒核心特征（速记）

Cursor Agent 运行在受限沙盒中：

- 非 login shell，不会自动 source `~/.zshrc`
- `TERM=dumb`，终端美化/彩色输出工具可能报错或降级
- stdout / stderr 可能被截断、合并或吞掉
- `cd && command` 可能失败（`cd` 可能被覆盖）
- 仓库目录写入可能被限制（重定向到仓库路径可能静默失败）
- `/tmp` 常可用于中转日志，但不保证跨会话持久
- 后台命令（`command &`）容易静默失败
- git porcelain 输出可能被吞，exit code 可能不可信

## 三 标准安全命令写法

### （一）默认推荐（不加载 zshrc）

```bash
# 默认：login shell + builtin cd
/bin/zsh -lc 'builtin cd /abs/path && <cmd>'
```

适用：大多数命令（node/pnpm/git 已在 PATH 中）。

### （二）必须加载环境时（去 starship 兜底）

```bash
# 方案 1：命令前禁用 starship，吞掉 zshrc 噪音
STARSHIP_CONFIG=/dev/null STARSHIP_SHELL= /bin/zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; builtin cd /abs/path && <cmd>'

# 方案 2：在 shell 内部导出
/bin/zsh -lc 'export STARSHIP_CONFIG=/dev/null; source ~/.zshrc >/dev/null 2>&1 || true; builtin cd /abs/path && <cmd>'
```

适用：fnm/nvm 初始化依赖 `~/.zshrc` 的场景。

### （三）禁止写法

```bash
# 禁止：易触发 starship 报错并污染输出
/bin/zsh -c "source ~/.zshrc && builtin cd /abs/path && <cmd>"

# 禁止：cd 可能被覆盖
cd xxx && <cmd>

# 禁止：假设仓库路径可写
<cmd> > .ggbdpq/tmp/out.log 2>&1

# 禁止：后台命令
<cmd> &
```

## 四 诊断顺序（固定流程）

遇到异常时按顺序排查：

1. `pwd`
2. `which node && node -v`
3. `which pnpm && pnpm -v`
4. `echo $TERM`
5. 是否涉及 `cd` / 重定向 / 后台
6. 用「处方 C」强制无颜色管道重跑

> 80% 的问题可在第 2 步确认。

## 五 处方模板（可直接复制）

### 处方 A：默认稳定执行

```bash
/bin/zsh -lc 'builtin cd /abs/path && <cmd>'
```

### 处方 B：必须 source zshrc 时的安全写法

```bash
STARSHIP_CONFIG=/dev/null STARSHIP_SHELL= /bin/zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; builtin cd /abs/path && <cmd>'
```

### 处方 C：stdout/stderr 被吞时取输出

```bash
# 优先级 1
NO_COLOR=1 TERM=dumb <cmd> 2>&1 | sed -n '1,200p'

# 优先级 2
script -q /dev/null <cmd> 2>&1 | strings | head -200

# 优先级 3
<cmd> > /tmp/cursor_out.txt 2>&1; sed -n '1,200p' /tmp/cursor_out.txt
```

### 处方 D：仓库路径写入失败

```bash
# 首选 /tmp 落盘
mkdir -p /tmp/cursor && <cmd> > /tmp/cursor/out.txt 2>&1; head -200 /tmp/cursor/out.txt

# /tmp 不可用时，直接管道
<cmd> 2>&1 | sed -n '1,200p'
```

### 处方 E：git 输出异常时的非 porcelain 读取

```bash
# 直接读取 .git 元数据
cat .git/HEAD 2>&1 | sed -n '1,5p'
ls -la .git/refs/heads 2>&1 | sed -n '1,50p'

# 关闭 pager / 签名输出
git -c pager.log=false -c log.showSignature=false log --oneline -n 20 2>&1 | sed -n '1,200p'
git -c pager.status=false status --short 2>&1 | sed -n '1,100p'
```

## 六 高频问题速查（去重版）

| 症状 | 根因 | 处理 |
|---|---|---|
| node/pnpm 版本不对 | fnm 未初始化 | 处方 B |
| `source ~/.zshrc` 报 starship 错误 | `TERM=dumb` 与 starship 冲突 | 处方 A 或 B |
| `cd` 失败 / 目录漂移 | `cd` 被覆盖 | `builtin cd` |
| 命令只有 RC=1 无详情 | 输出被吞/截断 | 处方 C |
| 写入仓库日志文件失败 | 仓库路径写入受限 | 处方 D |
| git 命令结果异常 | porcelain 输出不可靠 | 处方 E |
| script 无输出 | 实际是 pnpm script 未定义 | `pnpm run` 检查脚本 |
| pnpm lint/build exit 1 无输出 | bin shim 硬编码旧路径 | 处方 F |
| 连续多次命令无输出 | shell session 损坏 | 处方 G |
| `unable to unlink` 操作符号链接 | 沙盒文件系统限制 | 处方 H |
| fnm multishell 版本不一致 | pnpm 和 node 来自不同 session | 处方 I |
| git add/commit exit 1 无输出（读正常） | session 写操作被静默阻止 | 处方 J |
| Vite/Playwright 启动即退出无输出 | 沙盒网络/进程派生限制 | 处方 K |
| Node 子进程 execSync 无 stdout | 沙盒 stdio 拦截 | 处方 L |

## 七 故障补丁（2026-02-11 新增）

> 以下来自真实开发会话中的故障复盘，按处方编号延续。

### 处方 F：pnpm bin shim 路径错误（仓库迁移后）

**症状**：`pnpm lint`、`pnpm build`、`pnpm typecheck` 全部 exit 1 但无任何输出。`pnpm --version` 本身正常。

**根因**：`pnpm install` 在旧仓库路径执行，生成的 `node_modules/.bin/*` shim 脚本硬编码了旧绝对路径（如 `/Users/xxx/旧路径/skills-lab`），迁移目录后路径失效。

**确认方法**：

```bash
# 检查 shim 是否指向旧路径
head -3 node_modules/.bin/oxlint
# 看 basedir 是否匹配当前 pwd
```

**修复**（需要在用户终端执行，沙盒可能无权限）：

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install
```

**绕过方案**（沙盒内可用）：

```bash
# 直接定位 .pnpm 内的实际二进制，跳过 shim
node node_modules/.pnpm/oxlint@<version>/node_modules/oxlint/bin/oxlint .

# tsc 通常不受影响（纯 JS 脚本），可直接运行
./node_modules/.bin/tsc --noEmit
```

**关键经验**：
- pnpm 的 shim 与 npm 不同，使用 `basedir` 变量硬编码安装时的绝对路径
- 纯 Node.js 脚本（如 tsc）不受影响，原生二进制（如 oxlint、vite）受影响严重
- 一旦发现此问题，**不要反复重试**，直接让用户在终端 `pnpm install`

### 处方 G：Shell session 损坏（连续无输出）

**症状**：本来正常的命令突然全部 exit 1 无输出，连 `git status` 和 `echo test` 也无响应。

**根因**：Cursor 的 Shell tool 复用同一个 shell session，某些操作（如 `eval "$(fnm env)"`、频繁切换 `required_permissions`、长时间运行后）可能导致 session 状态损坏。

**修复**：

```bash
# 方案 1：换一个新的 shell session（在 Cursor 中用 working_directory 参数触发新 session）
# 注意：不需要做任何 source，直接发新命令即可

# 方案 2：减少 session 内的状态改动
# 避免在同一 session 中执行 eval/source/export 等改变环境的命令
```

**预防**：
- 避免在 shell session 中执行 `eval "$(fnm env)"`，改用 `working_directory` 参数让 Cursor 启动新 session
- 如果必须加载环境，用处方 B 的一次性写法，不污染 session
- 出现连续无输出时，**立即换 session**，不要继续在损坏的 session 中重试

### 处方 H：沙盒无法操作符号链接

**症状**：`git merge`、`git checkout` 报 `warning: unable to unlink 'xxx': Operation not permitted`。常见于 `.cursor/skills/` 等目录下的符号链接。

**根因**：Cursor 沙盒的文件系统权限对 `.cursor/` 目录下的文件有额外保护。

**处理**：

```bash
# 必须用 required_permissions: ["all"] 才能删除
rm -f .cursor/skills/<broken-link>
```

**典型场景**：
- 删除 broken symlinks 后，`git merge --no-ff` 虽然成功，但文件系统残留 untracked 文件
- 合并完成后需要手动 `rm -f` 或 `git clean -fd` 清理残留
- 这不影响 git 的记录（git 已经正确 track 了删除），只是工作区不干净

### 处方 I：fnm multishell 版本不一致

**症状**：`which node` 和 `which pnpm` 指向不同的 fnm multishell 目录（如 `multishells/54574` vs `multishells/94277`）。

**根因**：Cursor 打开多个 shell session 时，每个 session 的 fnm 初始化可能选择不同版本。

**处理**：

```bash
# 不要在沙盒 session 中折腾 fnm 环境
# 直接用绝对路径调用已知可用的 node
/Users/<user>/.local/share/fnm/node-versions/v24.13.1/installation/bin/node --version

# 或者使用 pnpm 自带的 script（pnpm 会自行解析正确的 node）
pnpm lint    # 如果 pnpm 本身可用
```

**预防**：
- 项目中保留 `.node-version` 和 `.nvmrc` 文件，让 fnm 自动切换
- 不依赖 shell session 中的 fnm 状态，优先用 `pnpm <script>` 间接调用

### 处方 J：git add/commit 在 session 中静默失败（2026-02-12 新增）

**症状**：`git add .` 或 `git add -A` 返回 exit 1 但无任何错误输出。`git diff --cached --stat` 确认 staged 为空。同一 session 中 `git status`、`git log` 等读操作完全正常。

**根因**：Cursor shell session 在某些操作序列后（如先进行了多次文件写入、pnpm 操作、权限切换等），session 的 git 写能力被静默禁用。这与处方 G（全面 session 损坏）不同——此时只有 git 写操作失败，读操作和其他命令正常。

**确认方法**：

```bash
# 1. 确认读正常
git status --short  # 有输出 → 读正常

# 2. 确认写失败
git add .           # exit 1 无输出
git diff --cached --stat  # 无输出 → 没有 staged

# 3. 确认不是权限问题（文件系统写入正常）
touch .git/test-write && rm .git/test-write  # 成功 → 文件系统可写
```

**修复——`bash -c` 子进程绕过**：

```bash
# 核心手法：用 bash -c 启动独立子进程执行 git 写操作
bash -c 'cd /abs/path && git add -A && echo "STAGED:" && git diff --cached --stat'

# add + commit 一步完成
bash -c 'cd /abs/path && git add -A && git commit -m "feat(scope): 描述"'

# push 同样需要子进程（加 required_permissions: ["all"]）
bash -c 'cd /abs/path && git push -u origin HEAD 2>&1'
```

**关键经验**：
- **不要反复重试** `git add`，直接切 `bash -c`
- `bash -c` 生成的子进程不继承 Cursor session 的损坏状态
- 建议在两段式提交流程中，**始终用 `bash -c` 包裹 git 写操作**，作为防御性编程
- 这是目前已知唯一可靠的沙盒内 git 写操作方式

### 处方 K：Vite/Playwright 等开发服务器在沙盒中无法启动

**症状**：`pnpm dev`、`npx vite`、`npx playwright test` 等需要启动 HTTP 服务器或浏览器的命令，在沙盒中立即退出（exit 0 或 exit 1），无任何有意义的输出。即使使用 `required_permissions: ["full_network"]` 或 `["all"]` 也无效。

**根因**：Cursor 沙盒对进程派生（fork/spawn）和网络端口监听有限制。开发服务器（Vite）需要绑定端口监听 HTTP 请求，Playwright 需要启动浏览器子进程——这两者都超出了沙盒的能力范围。

**确认方法**：

```bash
# Vite 版本可查但服务启动即退
npx vite --version  # 有输出 → 二进制存在
npx vite 2>&1       # 无输出或立即退出 → 沙盒限制

# Playwright 同理
npx playwright --version  # 有输出
npx playwright test 2>&1  # 无输出
```

**应对策略**：

1. **代码全部创建好，E2E 测试推迟到用户终端验证**
2. 在 evidence 或 progress 中标注"E2E 需在本地终端验证"
3. 单测（Vitest + jsdom）不需要网络和浏览器，在沙盒中可正常运行

**不要做的事**：
- 不要试图通过 Node 脚本间接启动 Vite——同样被限制
- 不要花时间调试 Vite 为什么不启动——这是沙盒固有限制
- 不要把 E2E 失败当作代码 bug

### 处方 L：Node 子进程 stdout 被沙盒拦截

**症状**：通过 Node 脚本（如 `node -e "..."`) 内部调用 shell 命令时，命令返回空输出或 stdout 完全被吞。直接在 shell 中执行同一命令有输出。

**根因**：沙盒对嵌套进程的 stdio 管道有额外拦截。`node → shell → command` 的三层嵌套中，最内层的 stdout 可能被截断或丢弃。

**处理**：

```bash
# 不要用 Node 子进程包装 shell 命令
# 正确写法：直接执行或用 bash -c
git status
bash -c 'git status'
```

**适用场景**：
- 当你想通过 Node 脚本检查环境状态时，改为直接用 shell 命令
- 当你需要在 Node 中处理命令输出时，先用 shell 命令写到 `/tmp`，再用 Node 读取文件

## 八 权限分级策略（`required_permissions` 决策树）

在 Cursor 沙盒中执行命令时，按以下决策树选择权限级别：

```
命令需要网络？
├─ 是（git push/fetch, pnpm install, npm install）
│  → required_permissions: ["full_network"]
├─ 否
│  ├─ 命令涉及 .cursor/ 或符号链接操作？
│  │  → required_permissions: ["all"]
│  ├─ 命令涉及 pnpm 脚本（lint/build/typecheck）？
│  │  ├─ 首次尝试：不加权限（沙盒默认）
│  │  └─ 失败（exit 1 无输出）：重试用 ["all"]
│  └─ 纯读取命令（git log, git status, cat）
│     → 不加权限
```

**经验法则**：
- `git push/pull/fetch` → `["full_network"]`
- `pnpm install` → `["full_network"]`（需要下载包）
- `pnpm lint/build` → 先不加，失败后 `["all"]`
- `rm -f .cursor/*` → `["all"]`
- `git checkout -f`（涉及受保护文件）→ `["all"]`

## 九 旧版经验并入（必要保留）

### （一）Rust 工具链专项诊断

```bash
/bin/zsh -lc 'builtin cd /abs/path && pwd && echo $PATH && which rustup rustc cargo && rustup show && rustc --version'
```

若缺失稳定工具链：

```bash
/bin/zsh -lc 'rustup toolchain install stable && rustup default stable && rustup show'
```

若 `~/.cargo/bin` 不在 PATH：

```bash
/bin/zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; builtin cd /abs/path && <cmd>'
```

### （二）归档仓库 push 失败归因

`ERROR: This repository was archived so it is read-only.` 属于仓库状态问题，不属于沙盒故障。

- 沙盒层只负责命令可观测性与稳定执行
- 仓库迁移策略见：`.cursor/rules/Git推送指南整合.md`

## 十 适用边界

- ✔ 适用于 Cursor IDE Agent（`execution_mode=cursor-sandbox`）
- ❌ 不保证终端直连 / 其他 IDE 行为一致
- ❌ 不保证未来 Cursor 版本行为完全不变

当环境行为变化时，新增“故障补丁”小节，不回写历史结论。

## 十一 使用原则（一句话）

> 在 Cursor 中遇到怪异问题：先按沙盒处方排障，再怀疑业务代码。
> 补充：连续无输出 → 换 session；bin shim 失败 → 让用户终端 `pnpm install`。
> 补充：git 写操作失败 → `bash -c` 子进程绕过；E2E 启动失败 → 推迟到用户终端。

---

最后更新：2026-02-12（新增处方 J/K/L：git 写操作静默失败、Vite/Playwright 沙盒限制、Node 子进程 stdout 拦截）