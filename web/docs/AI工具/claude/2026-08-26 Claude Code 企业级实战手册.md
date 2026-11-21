# Claude Code 企业级实战手册

> 写作日期：2026-08-26。
> 合并来源：《Claude Code 企业级使用与工程化学习指南》（739 行长文）与《2026-06-14 梳理 Claude Code 目录结构配置与企业级开发技巧》（208 行短文），并按 2026-08-26 官方文档（code.claude.com/docs）全面核对更新。两篇源文档已于 2026-08-26 删除，本手册是其唯一存续版本。
> 适用对象：熟悉 React、Vue、TypeScript、Vite 与前端工程化，希望系统掌握 Claude Code 目录治理、CLI 工程化与企业级协作的工程师。
> 信息口径分层：官方文档（2026-08-26 拉取 .md 源核验） > 本机 `claude.cmd` 实测（2.1.223） > 社区经验 > 个人推断。官方未明确说明的能力统一标注"待实测"。
> 安全边界：本文不包含密钥、账号、token、cookie、会话正文、私有仓库内容。

## 0. 结论摘要

Claude Code 是 Anthropic 的终端优先工程代理，2026-08 已形成 **CLI + IDE 扩展 + Web + 移动端 + 桌面 App** 五形态矩阵。它的价值来自六层组合：**明确目标（提示词）+ 分层记忆（CLAUDE.md 四层 + auto memory）+ 权限矩阵（六种 permission mode）+ 扩展体系（skills/hooks/subagents/MCP/plugins）+ 计划闭环（plan mode）+ 验证闭环（测试与 diff 审查）**。

核心治理面一览：

| 治理面 | 载体 | 一句话定位 |
|---|---|---|
| 分层记忆 | `CLAUDE.md`（Managed/User/Project/Local 四层）+ auto memory | cwd 向上拼接 + 子目录惰性加载 + `@import` 递归（≤4 跳） |
| 配置层级 | managed > CLI flags > local > project > user 五级 | 列表键跨层合并，安全键取更严值 |
| 权限矩阵 | 六种 `--permission-mode` + permissions allow/ask/deny | plan 模式物理隔离写操作 |
| 能力扩展 | Skills / Hooks / Subagents / MCP / Plugins | `.claude/commands` 已并入 skills 体系 |
| 隔离执行 | `-w/--worktree` + 后台 `--bg` + 云端 `--cloud` | 会话级隔离与接力 |
| 非交互 | `-p` + `--output-format json/stream-json` + `--bare` | CI/脚本化，退出码可判 |

事实优先级（处理任何冲突时按此排序）：用户当次明确指令 > 当前源码与配置 > 真实接口与命令输出 > 官方文档 > 本手册 > 社区经验。

### 0.1 本机只读核验（2026-08-26）

| 核验项 | 结果 | 说明 |
|---|---|---|
| 版本 | `claude.cmd --version` → `2.1.223` | Windows 需用 `claude.cmd` 而非 `claude` |
| 全局目录 | `~/.claude` 含 `CLAUDE.md`、`settings.json` + `settings.local.json`（各带 .annotated.jsonc）、`keybindings.json`、`skills/`、`hooks/`、`plugins/`、`projects/`、`sessions/`、`plans/`、`backups/`、`file-history/`、`shell-snapshots/`、`security/`、`session-env/`、`ide/`、`context-mode/`、`cache/`、`telemetry/`、`history.jsonl` | 结构完整，含 2026 新增的 `security/`、`file-history/` 等 |
| 敏感项 | `settings.json` 含凭据类字段 | **禁止提交**，排查时脱敏 |
| 对照旧快照 | 2026-06-14 的 `todos/`、`debug/` 已不在；新增 `backups/`、`file-history/`、`security/`、`session-env/`、`shell-snapshots/`、`ide/`、`hooks/`、`context-mode/` | 目录体系随版本演化 |

## 1. 定位与边界

### 1.1 五种入口形态

| 形态 | 主要用途 | 优点 | 限制 |
|---|---|---|---|
| CLI（终端） | 本地仓库代理、脚本化、CI | 最全能力面：worktree、后台、流式 JSON | 需理解权限与配置分层 |
| IDE 扩展（VS Code/JetBrains） | 编辑器内协作 | 选区/打开文件上下文、diff 预览 | 依赖扩展版本 |
| Web（claude.ai/code） | 浏览器会话 | `--cloud` 可从终端建/接管 web 会话 | 只读 `.claude/settings.json` + server-managed |
| 移动端 | 随时接力 | `--remote-control` 允许远程控制会话 | 安全边界需显式开启 |
| 桌面 App | 集成体验 | 与 CLI 会话互通 | 随版本变化 |

### 1.2 适合与不适合的任务

| 适合 | 原因 | 验收方式 |
|---|---|---|
| 陌生项目盘点 | 文件树 + CLAUDE.md + 命令输出形成项目地图 | 输出入口、技术栈、风险、验证命令 |
| Bug 定位与修复 | 报错 → 日志 → 测试 → 根因全链路 | 失败测试先红后绿 |
| 大规模重构 | plan mode + worktree 隔离 + 分阶段验收 | 每阶段可回滚 |
| 规则化团队治理 | CLAUDE.md/hooks/skills/subagents 分层 | 规则可审查、可复现 |
| 长时无人值守任务 | `--bg` 后台代理 + `claude agents` 监控 | 阶段性产物可审查 |
| 生产密钥操作 | 低——代理可接触用户权限内文件 | 人手执行，Claude 只出步骤 |

## 2. 核心工作模型

六层任务流：**指令层（提示词与权限）→ 上下文层（CLAUDE.md/memory/文件）→ 工具层（Read/Edit/Bash/MCP）→ 计划层（plan mode + ExitPlanMode 审批）→ 验证层（测试/构建/diff）→ 复盘层（auto memory/规则沉淀）**。

权限模式是安全主轴（详见 §6）：默认 `default` 逐项确认；`plan` 只读规划；`acceptEdits` 放行编辑；`auto` 分类器全托管；`dontAsk` 预批准外全拒（CI）；`bypassPermissions` 仅限隔离环境。

## 3. CLI 命令全景

### 3.1 高频启动形态

```powershell
claude                                   # 交互式
claude "任务描述"                         # 带初始提示
claude -c                                # 继续当前目录最近会话（-c 现为 --continue）
claude -r                                # 会话选择器
claude -r <session-id|name>              # 按 ID 或名称恢复（v2.1.223 起可跨项目按 ID 查找）
claude -n <name> "任务"                   # 命名会话，便于后续 --resume <name>
claude -p "任务" --output-format json     # 非交互（含 result/session_id/total_cost_usd）
claude -w feature-x                      # 在 <repo>/.claude/worktrees/feature-x 建 worktree 隔离
claude --bg "长任务"                      # 后台代理（与 -p 互斥）
```

### 3.2 关键 flags（2026-08-26 官方核验，节选）

| Flag | 说明 |
|---|---|
| `--permission-mode <mode>` | default / acceptEdits / plan / auto / dontAsk / bypassPermissions / manual（manual 为 default 别名） |
| `--allowedTools "Bash(git diff *),Read"` | 免确认白名单（尾随 ` *` 前缀匹配） |
| `--disallowedTools "Edit"` | 拒绝；裸工具名会从上下文移除该工具 |
| `--tools ""` | 限制内置工具集（空 = 全禁；不影响 MCP） |
| `--model` | 别名 sonnet/opus/haiku/fable 或完整 ID；覆盖 ANTHROPIC_MODEL |
| `--fallback-model "sonnet,haiku"` | 降级链 |
| `--max-turns N` / `--max-budget-usd N` | 轮数/花费上限（仅 -p；预算含子代理） |
| `--json-schema <file>` | 结构化输出（配 --output-format json，结果在 structured_output） |
| `--add-dir <path>` | 追加工作目录 |
| `--agents <json>` / `--agent <name>` | 动态定义子代理 / 以子代理身份运行整个会话 |
| `--settings <file\|json>` | 覆盖各 settings 同键（≤2 MiB） |
| `--setting-sources user,project,local` | 控制加载哪些 settings 层 |
| `--system-prompt-file` / `--append-system-prompt` | 替换/追加系统提示（replace 二者互斥） |
| `--effort low..max` | 推理力度 |
| `--mcp-config <file>` / `--strict-mcp-config` | 加载/独占 MCP 配置 |
| `--session-id <uuid>` / `--fork-session` | 指定/派生会话 ID |
| `--bare` | 跳过 hooks/skills/plugins/CLAUDE.md 的快速模式（脚本推荐，将成 -p 默认） |
| `--safe-mode` | 排障：禁用全部自定义 |
| `--cloud` / `--teleport` | 建/接管 claude.ai web 会话 |
| `--remote-control` (`--rc`) | 允许 claude.ai/移动端远程控制 |
| `--dangerously-skip-permissions` | 等价 bypassPermissions（仅隔离环境） |

注：`claude --help` 不列全量 flag，官方明示"flag 不在 --help 中不代表不可用"。旧资料中 `-c/--context` 说法已过时——`-c` 现为 continue，上下文查看用 `/context` 命令。

### 3.3 一级子命令（节选）

| 命令 | 说明 |
|---|---|
| `claude update` / `claude install [stable\|latest]` | 更新/安装原生二进制 |
| `claude auth login/logout/status` | 认证（status 支持 --text） |
| `claude mcp add/list/get/remove` | MCP 管理（§8） |
| `claude mcp login/logout <name>` | MCP OAuth |
| `claude doctor` | 只读诊断（安装健康、settings 校验）；会话内 `/doctor` 可修复 |
| `claude agents` | 监控/派发并行后台会话（--cwd/--json/--all） |
| `claude attach/logs/stop <id>` | 管理后台会话 |
| `claude plugin` | 插件管理 |
| `claude project purge [--dry-run]` | 清除项目本地状态 |
| `claude setup-token` | CI 长期 token |
| `claude import [codex\|gemini]` | 迁移其他 agent 配置（v2.1.213+） |

### 3.4 Slash 命令精选（2026-08-26 全表核验后的变化点）

高频且稳定的：`/init`（生成 CLAUDE.md）、`/plan`、`/compact`、`/context`（上下文占用）、`/memory`（编辑记忆文件）、`/model`、`/permissions`、`/hooks`、`/skills`、`/agents`、`/mcp`、`/config key=value`、`/export`（导出会话）、`/rewind`（checkpoint 回退，别名 /undo /checkpoint）、`/usage`（= /cost = /stats）、`/doctor`、`/tasks`、`/ide`、`/add-dir`、`/fork`、`/resume`（= /continue）。

**2026 年变化点**（旧资料常见错误）：

| 旧说法 | 现状 |
|---|---|
| `/todos` | 已改 `/tasks` |
| `/pr-comments` | v2.1.91 移除，直接让 Claude 查 PR 评论 |
| `/vim` | v2.1.92 移除，改 `/config` → Editor mode |
| `/ultraplan` | 并入 plan mode |

新增值得用：`/code-review`（= /review）、`/security-review`、`/effort`、`/statusline`、`/fast`（快速输出档）、`/workflows`、`/bug`。

### 3.5 键盘快捷键（Windows 注意）

| 键 | 作用 |
|---|---|
| `Esc` | 中断；权限弹窗上等同拒绝 |
| `Esc Esc` | 清空草稿 / 空输入时打开 rewind 菜单 |
| `Shift+Tab` | 循环权限模式（**Windows 无 VT 时为 Alt+M**） |
| `Ctrl+O` / `Ctrl+R` / `Ctrl+L` | transcript / 历史搜索 / 重绘 |
| `Ctrl+B` / `Ctrl+T` | 转后台 / 任务清单 |
| `!` 前缀 | shell 模式（输出入上下文） |
| `@` / `#` | 文件路径补全 / emoji 短码（`#` 记忆前缀已不存在，用 `/memory`） |
| 多行 | `\`+Enter 或 Shift+Enter |

## 4. 目录与 Git 策略

### 4.1 用户级目录（本机 2026-08-26 观察）

```txt
~/.claude/
  CLAUDE.md                  # 用户级记忆（个人宪法）
  settings.json              # 用户配置（含敏感字段，禁提交）
  settings.local.json        # 本地覆盖
  settings.annotated.jsonc   # 官方带注释参考（只读学习材料）
  keybindings.json  history.jsonl
  skills/  hooks/  plugins/  plans/
  projects/<project>/        # 每项目会话与 auto memory
  sessions/  backups/  file-history/  shell-snapshots/
  security/  session-env/  ide/  context-mode/  cache/  telemetry/
```

| 类型 | 治理建议 |
|---|---|
| 记忆 `CLAUDE.md` | 稳定原则与偏好，目标 <200 行，禁密钥 |
| 配置 `settings*.json` | 敏感字段脱敏后才可外传；`.bak` 链保留变更史 |
| 能力 `skills/`、`hooks/`、`plugins/` | 单一职责，定期审查来源与权限 |
| 状态 `projects/`、`sessions/`、`file-history/` 等 | 本机运行状态，禁止提交 |

### 4.2 项目级推荐结构

```txt
project-root/
  CLAUDE.md                  # 项目记忆（团队共享）
  CLAUDE.local.md            # 个人本地（gitignore）
  .claude/
    settings.json            # 团队共享配置（权限/hooks/statusLine）
    settings.local.json      # 个人（gitignore）
    rules/*.md               # frontmatter paths: 条件加载的规则
    skills/review-pr/SKILL.md
    agents/frontend-reviewer.md
    commands/                # 已并入 skills 体系（同名 skill 优先）
  .mcp.json                  # 项目级 MCP（入版本库）
  docs/ai-development/claude-code-workflow.md
```

### 4.3 Git 策略

- 提交：`CLAUDE.md`、`.claude/settings.json`、`.claude/rules/`、`.claude/skills/`、`.claude/agents/`、`.mcp.json`（脱敏）。
- gitignore：`CLAUDE.local.md`、`.claude/settings.local.json`、`~/.claude` 全部。
- CLAUDE.md 加载顺序：cwd 逐级向上**拼接**（根先读，越近越后读）；子目录 CLAUDE.md 在读取该目录文件时惰性加载。
- `@import`：相对路径基于包含文件，递归 ≤4 跳；项目文件引用外部路径（如 `@~/.claude/x.md`）首次需批准。
- AGENTS.md：Claude Code 不直接读，官方建议 CLAUDE.md 内写 `@AGENTS.md` 引用（Windows 符号链接需管理员，import 更稳）。

## 5. 配置治理（settings.json）

### 5.1 五级优先级（官方核验）

**Managed**（managed-settings.json / MDM / claude.ai 控制台） > **命令行**（flags、`--settings`） > **Project local**（`.claude/settings.local.json`） > **Shared project**（`.claude/settings.json`） > **User**（`~/.claude/settings.json`）。

- 列表键（如 `permissions.allow`）跨层**合并**；少数安全键（disableClaudeAiConnectors 等）取更严值。
- `~/.claude.json` 是 CLI 自用文件（登录态、MCP、项目信任），勿手改。
- `$schema: https://json.schemastore.org/claude-code-settings.json`；文件热重载 + `ConfigChange` hook。

### 5.2 三档团队模板（从长文指南精编）

新手安全版（用户级）：

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep"],
    "deny": ["Bash(rm *)", "Bash(git push *)", "Read(.env*)", "Read(**/*.pem)"],
    "defaultMode": "default"
  },
  "includeCoAuthoredBy": false
}
```

前端项目版（`.claude/settings.json`）：

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run *)", "Bash(npx *)", "Bash(git diff *)", "Bash(git log *)",
      "Read(src/**)", "Edit(src/**)", "Write(src/**)"
    ],
    "deny": ["Bash(npm publish *)", "Read(.env*)", "Edit(.env*)", "Write(pnpm-lock.yaml)"],
    "defaultMode": "acceptEdits"
  },
  "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" }
}
```

企业治理版（managed 层）：

```json
{
  "permissions": {
    "allow": [],
    "ask": ["Bash(git push *)", "Bash(npm publish *)"],
    "deny": [
      "Read(.env*)", "Read(**/*.pem)", "Read(**/secrets/**)",
      "Bash(curl *)", "Bash(sudo *)", "WebFetch(*)"
    ],
    "defaultMode": "default",
    "disableBypassPermissionsMode": "disable"
  },
  "forceLoginMethod": "sso",
  "disableAllHooks": false
}
```

### 5.3 CLAUDE.md 模板（前端项目，精编）

```markdown
# 项目名

## 技术栈
React 18 + TypeScript + Vite + Tailwind；测试 Vitest + Playwright。

## 常用命令
- pnpm dev / pnpm build / pnpm test / pnpm lint

## 代码约定
- 组件用函数式 + named export；样式用 Tailwind，禁止 inline style
- 提交前必须过 lint + typecheck + test

## 安全边界
- 禁止读取或输出 .env* 与任何密钥文件
- 修改 package.json 依赖前必须暂停询问

## 变更政策
- CLAUDE.md 默认稳定；规则更新需在 PR 中说明触发原因
```

体量红线：目标 <200 行；>4 MiB 直接跳过加载；`.claude/rules/*.md` 支持 frontmatter `paths:` 按 glob 条件加载（预算 1000 模式 / 4 MiB）。

## 6. 权限与安全

### 6.1 六种权限模式（官方核验）

| 模式 | 免确认范围 | 适用 |
|---|---|---|
| `default`（UI 名 Manual） | 仅读取 | 生产/敏感仓库 |
| `acceptEdits` | 读取 + 文件编辑 + mkdir/touch/rm/mv/cp/sed 等文件系统命令 | 日常开发 |
| `plan` | 只读（+分类器批命令）；编辑封锁至计划批准 | 方案设计 |
| `auto` | 全部，分类器后台审查 | Pro/Max/Team 终端内置默认；`defaultMode:"auto"` 仅 user/managed 层生效 |
| `dontAsk` | 仅预批准工具，其余自动拒绝 | CI |
| `bypassPermissions` | 全部（含受保护路径） | **仅隔离容器/VM** |

官方原文警告要点：bypassPermissions 对提示注入无任何防护；需要更少弹窗的后台安全检查请用 auto mode。Linux/macOS 以 root/sudo 拒绝启动；云会话忽略 settings 里的 bypass/dontAsk。受保护路径（.git/.claude 等）默认不自动批；`rm -rf /`、`~` 等关键路径任何模式都不能被 allow 规则或 hook 放行。

### 6.2 权限规则语法

- `Bash(git diff *)`：尾随 ` *` 前缀匹配；`Bash(npm run build)` 精确匹配。
- `Read(.env*)` / `Edit(src/**)` / `WebFetch(domain)` / `Mcp(server:tool)` / `Skill(name)` / `Agent(type)`。
- 三区语义：allow 免确认、ask 必问、deny 拒绝；deny 恒胜。
- `allow` 与 `env` 需 workspace trust；`deny`/`ask` 立即生效。

### 6.3 Plan mode 闭环

进入：`Shift+Tab` 循环、`/plan`、`claude --permission-mode plan`。流程：只读研究 → 计划写入磁盘文件 → `ExitPlanMode` 呈批（Ctrl+G 可先编辑计划文本）→ 批准即切回执行模式。配套内置子代理：`Explore`（只读侦察）、`Plan`（规划期研究）。

## 7. 提示词与上下文技巧

| 技巧 | 适用场景 | 具体做法 |
|---|---|---|
| plan 先行 | 多文件改造 | 先 plan 模式出方案人审，批准后执行 |
| /compact 节流 | 长会话 | 上下文吃紧时手动压缩，或 /autocompact 自动 |
| /context 体检 | 上下文膨胀 | 查看各来源占用，裁剪 CLAUDE.md |
| @ 精确投喂 | 大仓库 | @file @dir 只给需要的上下文 |
| 子代理隔离 | 并行侦察 | Explore 只读扫多个模块，主上下文只收结论 |
| worktree 并行 | 多任务 | `claude -w` 每任务独立 worktree |
| memory 沉淀 | 反复出错 | 第三次纠正同一错误即写入 CLAUDE.md 或 auto memory |
| ! shell 模式 | 快速命令 | `! pnpm test` 输出直接入上下文 |
| 导出复盘 | 团队共享 | /export 导出会话脱敏后归档 |

### 7.1 高频 Prompt 模板（从长文 60+ 条精选）

只读盘点：

```txt
请只读分析当前项目：技术栈、入口、目录职责、关键配置、风险点、建议验证命令。
不要创建、修改、删除文件，不要安装依赖，不要提交代码。
凭据相关只输出字段类别，禁止输出具体值。
```

最小改动：

```txt
请按 Read、Plan、Execute 三阶段处理。Plan 必须包含文件白名单、测试策略、验收点、回滚点和风险。
在我确认前不要修改文件。确认后只改白名单文件，先补失败测试，再做最小实现。
交付时说明真实执行过的验证命令和未验证事项。
```

Bug 修复（TDD）：

```txt
先复现：找到或编写一个能失败的测试，确认失败原因与该 bug 一致。
再修复：最小改动让测试转绿，不引入无关变更。
最后说明：根因、修复点、验证命令、回归风险。
```

代码审查：

```txt
请审查当前 diff：按严重度列出问题（阻断/警告/建议），
每条给出文件行号、影响场景、修复建议。只读，不修改代码。
```

规则沉淀：

```txt
请把本次任务可复用的经验沉淀为规则：只保留高频、明确、可执行的条目，
每条说明触发场景、禁止事项、验证方式和维护位置。
不要写入一次性背景、会话记录、密钥、临时路径。
```

## 8. 能力扩展：MCP、Skills、Hooks、Subagents、Plugins

### 8.1 MCP

三作用域：**local**（默认，`~/.claude.json` 项目条目） > **project**（根 `.mcp.json`，入版本库，首启需批准） > **user**（`~/.claude.json` 顶层）。

```powershell
claude mcp add github -s user -- https://api.githubcopilot.com/mcp/ --transport http
claude mcp add-json db '{"command":"node","args":["db-server.js"]}'
claude mcp list          # 含健康状态
claude mcp login github  # OAuth
claude serve             # Claude Code 自身作为 MCP 服务器暴露
```

要点：`.mcp.json` 支持 `${VAR}` 与 `${VAR:-default}` 展开；SSE 已标记 deprecated；输出上限默认 25k token（`MAX_MCP_OUTPUT_TOKENS`）；企业可用 managed-mcp.json 管控 allowed/denied 列表。

### 8.2 Skills（`.claude/commands` 已并入）

- 位置：Enterprise(managed) > `~/.claude/skills/` > `.claude/skills/` > 插件 `<plugin>/skills/`；同名覆盖 enterprise > personal > project > bundled。
- 结构：`SKILL.md` = YAML frontmatter（description、allowed-tools、context: fork 等）+ 正文，建议 <500 行。
- 渐进披露：只有 description 常驻上下文，正文调用时注入——鼓励"多而专"。
- 调用：`/skill-name` 或模型按 description 自主触发；权限可用 `Skill(name)` 规则控制。

### 8.3 Hooks（31 事件、5 种 handler）

事件分层：会话（SessionStart/End、Setup）、输入（UserPromptSubmit）、工具（PreToolUse、PermissionRequest/Denied、PostToolUse/Failure）、输出（Stop、Notification）、子代理（SubagentStart/Stop）、压缩（Pre/PostCompact）、环境（CwdChanged、FileChanged、WorktreeCreate、ConfigChange）等。

handler 五种：command / http / mcp_tool / prompt（LLM 判定）/ agent（实验）。决策语义：exit 2 = 阻断；exit 0 + JSON = 精控（PreToolUse 可回 `permissionDecision: allow/deny/ask` + `updatedInput`）。

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command",
        "command": "node .claude/hooks/block-dangerous.js" }]
    }]
  }
}
```

铁律：策略钩子必须 exit 2（exit 1 不阻断）；`disableAllHooks` 关不掉 managed hooks；先 dry-run 再启用阻断。

### 8.4 Subagents

`.claude/agents/*.md`（项目）与 `~/.claude/agents/`（用户），frontmatter 必需 `name`（小写连字符）+ `description`；可选 `tools`、`model`、`permissionMode`、`maxTurns`、`skills`、`mcpServers`、`isolation: worktree` 等。内置：`Explore`（只读侦察）、`Plan`（规划）、`general-purpose`。嵌套默认 3 层；并发默认 20；`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` 可移除内置。

### 8.5 Plugins

`claude plugin` 管理；插件可携带 skills/agents/hooks/MCP；企业从 claude.ai 控制台下发。来源可信度审查优先。

## 9. 会话与上下文管理

| 操作 | 命令 |
|---|---|
| 继续 | `claude -c` / 会话内 `/resume` |
| 选择器 | `claude -r` |
| 按名称/ID | `claude -r <name>`（配 `--name` 创建） |
| 后台 | `--bg` 启动；`claude agents` 监控；`claude attach/logs/stop <id>` |
| 派生 | `--fork-session` / `/fork` |
| 压缩 | `/compact`、`/autocompact` |
| 检查占用 | `/context` |
| 回退 | `Esc Esc` 或 `/rewind`（checkpoint） |
| 跨端 | `--cloud`（web）、`--rc`（移动端控制） |

Auto memory：`~/.claude/projects/<project>/memory/`（MEMORY.md 索引 + 主题文件），按 git 仓库共享、worktree 共用；`autoMemoryEnabled` 可关。

## 10. 企业级工作流

### 10.1 标准闭环

```txt
目标澄清 → 只读盘点(Explore/plan) → 最小方案(ExitPlanMode 审批) → 授权执行 → 测试验证 → diff 审查(/review) → 文档沉淀 → 规则更新(CLAUDE.md/skills/hooks)
```

| 阶段 | 关键动作 | 交付物 |
|---|---|---|
| Read | Explore 子代理并行扫模块，主上下文收结论 | 项目地图和风险清单 |
| Plan | plan mode 出文件白名单、验收点、回滚点 | 可确认的执行计划 |
| Execute | 只改白名单文件，先测试后实现 | 最小 diff 和验证结果 |
| Review | /code-review + /security-review 双通道 | 可追踪 findings |
| Retrospective | 高频纠正点沉淀为 CLAUDE.md 条目/skill/hook | 规则更新记录 |

### 10.2 CI/CD 与团队治理

- 脚本化：`claude -p --bare --output-format json --max-budget-usd 2`；`--allowedTools` 收窄；退出码判定（成功 0；SIGTERM 143）。
- 首事件 `system/init` 含 mcp_servers/plugin_errors，可做 CI 门禁。
- 团队统一：managed-settings.json 下发 deny 矩阵 + Team 插件 + enforced hooks。
- 合规红线：CLAUDE.md 禁密钥；hooks 日志脱敏；会话导出脱敏后才可外传。
- 跨模型工作流：Claude Code 实现 + 另一独立上下文模型 QA 交叉审查，是社区验证过的质量增益手段。

## 11. 失败模式与修复

| 症状 | 根因 | 修复 |
|---|---|---|
| `-c` 不是 continue | 旧版本或误解（-c 曾被写作 context） | 升级到 ≥2.1.223；上下文查看用 `/context` |
| `/todos` 不存在 | 已改 `/tasks` | 用新命令 |
| settings 改了不生效 | 优先级被上层覆盖 / 未热重载 | 按五级优先级排查；检查 ConfigChange |
| hooks 不阻断 | exit 1 而非 exit 2 | 策略钩子返回 exit 2 |
| bypassPermissions 被拒 | root/sudo 运行或云会话忽略 | 非 root 运行；云会话改用 auto/dontAsk |
| auto 模式不生效 | `defaultMode:"auto"` 写在了项目层 | 仅 user/managed 层生效 |
| CLAUDE.md 超限不加载 | >4 MiB 或 import 超 4 跳 | 拆分瘦身，目标 <200 行 |
| AGENTS.md 不被读 | Claude Code 不直接读 | CLAUDE.md 内 `@AGENTS.md` |
| MCP server 反复认证失败 | OAuth 过期 | `/mcp` 面板或 `claude mcp login <name>` |
| 子代理不生效 | 新目录未重启 / 名称含 `:` | 重启会话；name 用小写连字符 |
| Windows 下 `claude` 报错 | PowerShell 解析 | 用 `claude.cmd` |
| 中文文件读写乱码 | 编码缺省 | 工具侧用 Read/Write；PowerShell 显式 UTF-8 |

## 12. 90 天进阶路线

| 周期 | 目标 | 实战任务 | 主动回忆问题 | 验收产物 |
|---|---|---|---|---|
| 第 1-2 周 | 安装、认证、目录心智 | 只读盘点两个真实前端项目 | 五级 settings 谁覆盖谁 | 目录职责表 |
| 第 3-4 周 | CLAUDE.md 与 rules | 为项目写 <200 行记忆 + paths 条件规则 | 四层记忆如何拼接加载 | 记忆文件 |
| 第 5-6 周 | 权限矩阵 | 在测试仓库跑通六种 permission-mode | auto 与 bypass 的本质区别 | 安全配置笔记 |
| 第 7-8 周 | plan mode 与 TDD | 一个 bug 走完 plan→测试→修复→review | ExitPlanMode 审批点在哪 | 红→绿 diff |
| 第 9-10 周 | Hooks/Subagents | 拦截危险命令的 PreToolUse hook + 只读 reviewer 子代理 | exit 2 与 JSON 决策差异 | hook 与 agent 文件 |
| 第 11-13 周 | 企业级方法论 | managed 模板 + CI `-p --bare` + 团队 skills 串成闭环 | 哪些经验值得制度化 | 团队 AI 开发手册 |

## 13. 一页速查表

```powershell
# 日常
claude                     # 交互
claude -c                  # 继续
claude -r <name>           # 按名恢复
claude -p "任务" -o json    # 非交互
claude -w feature-x        # worktree 隔离
claude --bg "长任务"        # 后台

# 诊断与管理
claude doctor / claude auth status
claude mcp list / claude agents
claude update

# 会话内高频
/init  /plan  /compact  /context  /memory  /permissions  /review  /rewind
/tasks  /agents  /skills  /hooks  /mcp  /usage  /doctor  /export

# 安全速记
--permission-mode: default|acceptEdits|plan|auto|dontAsk|bypassPermissions
deny 恒胜 allow；bypass 仅限隔离环境；CI 用 dontAsk + --bare
```

## 14. 未验证项与来源

### 14.1 未验证项（截至 2026-08-26）

- settings-reference 逐键细节：官方页未拉取。
- `claude gateway`、`self-hosted-runner`、`ultrareview`、SDK（agent-sdk/*）：仅确认存在，未实测。
- auto mode 分类器行为细节、Remote Control 资格条件：以官方页为准。
- 隐藏命令（/heapdump、/rate-limit-options、/setup-bedrock 等）：存在但非公开承诺，勿依赖。

### 14.2 来源链接（2026-08-26 拉取 .md 源核验）

| 来源 | 链接 | 用途 |
|---|---|---|
| CLI reference | https://code.claude.com/docs/en/cli-reference.md | flags 与子命令 |
| Commands | https://code.claude.com/docs/en/commands.md | slash 全表与移除记录 |
| Interactive mode | https://code.claude.com/docs/en/interactive-mode.md | 快捷键 |
| Memory | https://code.claude.com/docs/en/memory.md | CLAUDE.md 分层与 auto memory |
| Settings | https://code.claude.com/docs/en/settings.md | 五级优先级 |
| Hooks | https://code.claude.com/docs/en/hooks.md | 31 事件与 handler |
| Skills | https://code.claude.com/docs/en/skills.md | 与 commands 合并 |
| Subagents | https://code.claude.com/docs/en/sub-agents.md | frontmatter 与内置代理 |
| Permission modes | https://code.claude.com/docs/en/permission-modes.md | 六模式与 bypass 警告 |
| MCP | https://code.claude.com/docs/en/mcp.md | 三作用域与企业管控 |
| Headless | https://code.claude.com/docs/en/headless.md | -p/--bare/退出码 |
| Worktrees | https://code.claude.com/docs/en/worktrees.md | -w 细节 |
