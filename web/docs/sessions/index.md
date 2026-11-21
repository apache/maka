# sessions 归档索引

- 更新：2026-10-26

## Windows 会话迁移（2026-10-26）

- 背景：home 目录按白名单模式只跟踪配置，各 Coding Agent 的会话类高频数据统一迁入 sessions；cursor plans/projects 已由 codex 先行迁移（[raw/cursor/migration-20261026-120731](raw/cursor/migration-20261026-120731/VERIFICATION.txt)）
- 脚本：[tools/migrate_home_agents.py](tools/migrate_home_agents.py)，沿用 cursor 迁移状态机（baseline 清单 → archive 打包校验 → apply 删除 → verify → rollback-test 沙箱回演），进程守卫在对应 CLI 运行时拒绝操作；junction/锁定文件记入 skipped 保留原地；**记录档（会话/日志）逐文件 SHA-256 严格校验，缓存档（可再生）体积校验快速路径免回滚测试**
- 首轮（claude/kimi/gemini）：claude 5 组 1256 文件 217.4 MiB、kimi 448 文件 61.8 MiB、gemini 5 文件 4.5 MiB，均五步全绿
- 第二轮全面排查（30 个 Agent，记录档全绿、缓存档四步绿）：
  - 记录档归 raw：factory 168MB、codex 两批 236+16863 文件（sessions/attachments/thread-history/sqlite 日志库）、grok、kimi-code、kimi、deepseek、dsh、copilot、lody、cc-switch 日志、amp、opencode snapshot、workbuddy(-ai) 日志/会话、antigravity-cockpit 日志
  - 缓存档归 _trash：`.cache/codex-runtimes` 7GB、trae-cn extensions+builtin 2.45GB、qoder(+cn) 1.63GB、codex plugins/sandbox-bin/tmp 等 1.68GB、workbuddy(-ai) plugins/app/marketplace 580MB、cc-switch backups 424MB、grok downloads 489MB、codegeex mamba 353MB、antigravity(+ide)/lingma/kiro/codebuddy(+cn) extensions 310MB、各 Electron 桌面端标准缓存（Codex/Antigravity×2/kimi-desktop/Qoder/Lingma/Grok Bot/Factory/opencode/codepilot/Wave）+ `Local\Codex` 日志快照 + `Local\OpenAI\Codex\runtimes` 253MB
  - 合计约 14.8 万文件 / ~19GB 移出 home；回滚 = 各 migration 目录 ROLLBACK.sh（缓存档 zip 在 _trash）
- 保留不动：`.codex/share`（用户自存微信工具数据）、`.codex` sqlite/memories/全局状态与全部 auth/secrets、各账号凭证库（cockpit accounts、cc-switch db）、VS Code（Roaming\Code 日常驱动混合状态）、`.zcode`（在用）、kimi-desktop `Partitions`/IndexedDB 与各端 `web`/`Network`（含登录态）、workbuddy `binaries`（PortableGit junction）、`.vibeusage`/`.tokentracker`（用量追踪器）、各 `*-updater` 与旧版本 `app-*`（安装器缓存 ~3GB，可手动删）

## Mac 增补（2026-10-25）

- 脚本：[tools/archive_mac_2026-10-25.mjs](tools/archive_mac_2026-10-25.mjs)（archive_phase2.py 的 Node 适配：同 md 格式/命名/脱敏；zst 会话由 Node zlib 解压；**不复制 raw、不删源**，源保留在 `~/.claude/projects`、`~/.codex/sessions`、`~/.cursor/projects`；`~/.zcode` 未动）
- 处理范围：claude 2 个 jsonl、codex 279 个（20 jsonl + 259 zst）、cursor 54 个 agent-transcripts
- 结果：新增 md **claude 2 / codex 173 / cursor 1**；与 Windows 归档重复跳过 codex 91、cursor 52（按 id8 幂等去重，md 既有文件未改动）；无实质内容跳过 codex 15、cursor 1；manifest.jsonl 追加 176 行（archive 字段为 `-`，源即本机路径）
- 主要新增项目：codex/Users-ggbdpq-cc-ggbdpq-interview-coding-agent 41、codex/Users-ggbdpq-cc-ggbdpq-fork 18、codex/Users-ggbdpq-Documents-Codex-2026-10-02-new-chat 12、claude/Users-ggbdpq 2 等，明细见 manifest
- curated/：同日并入三份会话沉淀（cursor plans 21、项目记录 7+2、AI 对话知识资产 v2 整树），见 [curated/README.md](curated/README.md)

## 按工具（Windows 首归档 2026-10-20 基线）

| 工具 | 会话数 | md 数 | 原始月度包 |
|---|---|---|---|
| claude | 222 | 222 | raw/claude/（5 个 zip） |
| codex | 169 | 158 | raw/codex/（2 个 zip） |
| cursor | 68 | 52 | raw/cursor/（2 个 zip） |
| factory | 28 | 26 | raw/factory/（1 个 zip） |
| kimi | 7 | 7 | raw/kimi/（1 个 zip） |
| zcode | 294 | 294 | raw/zcode/（1 个 zip） |

## 按项目（md 落盘的项目）

| 工具/项目 | 会话数 |
|---|---|
| codex/C-Users-802165 | 83 |
| claude/c-Users-802165 | 67 |
| cursor/unknown | 52 |
| zcode/E-Projects-frontend-homing-miniapp-workbench | 51 |
| codex/E-Projects-frontend-homing-miniapp-workbench | 35 |
| claude/e-Projects-frontend-beauty-smart-advisor | 29 |
| claude/C-Users-802165 | 23 |
| zcode/E-cc | 23 |
| zcode/C-Users-802165 | 22 |
| zcode/E-ggbdpq-gh-fork-maka | 22 |
| zcode/E-cc-guahub-fork-magpie-hub | 22 |
| claude/e | 20 |
| zcode/E | 20 |
| factory/E-cc-guahub-fork-magpie-hub | 16 |
| zcode/E-guahub-gh-fork-maka | 14 |
| zcode/C-Users-802165-vibe-console | 12 |
| codex/E-Projects-backend-node-ai-customer-recognition-node-btf | 11 |
| zcode/E-cc-guahub-fork-magpie-hub-magpie | 10 |
| claude/e-guahub-registration-toolkit | 9 |
| claude/e-guahub | 9 |
| zcode/E-Projects-frontend-beauty-smart-advisor | 9 |
| zcode/C-Users-802165-.ai-categories-03 | 9 |
| claude/E | 8 |
| codex/E-Projects-frontend-fix-bugs-homing-miniapp-workbench | 8 |
| factory/E-Projects-frontend-homing-miniapp-workbench | 8 |
| zcode/E-Projects-backend-node-ai-customer-recognition-node-btf | 8 |
| kimi/unknown | 7 |
| zcode/E-guahub | 7 |
| zcode/E-cc-guahub-fork-maka-hub | 7 |
| codex/E-Projects-requirements-analysis | 6 |
| claude/e-Projects-backend-node-mock-gateway | 5 |
| claude/e-Projects-frontend-homing-miniapp-workbench | 5 |
| zcode/C-Users-ggbdpq | 5 |
| zcode/E-cc-guahub-fork | 5 |
| claude/e-Projects-homing-miniapp-workbench | 4 |
| zcode/E-ggbdpq-guahub | 4 |
| zcode/E-Projects-frontend-fix-bugs-homing-miniapp-workbench | 4 |
| zcode/E-ggbdpq-web-05--03-AI-V1.7.2 | 4 |
| claude/C-Users-802165-vibe-inbox-cpa-manage | 3 |
| claude/e-Projects-specs | 3 |
| codex/E-Projects-frontend-beauty-smart-advisor | 3 |
| codex/E-guahub-gh-fork-maka | 3 |
| codex/E-guahub-vibe-cursor-loc | 3 |
| codex/E-cc-guahub-fork-magpie-hub | 3 |
| zcode/E-ggbdpq | 3 |
| zcode/E-ggbdpq-guahub-gh-fork-maka | 3 |
| zcode/E-ggbdpq-gh-fork-maka-packages-runtime | 3 |
| zcode/E-ggbdpq-interview | 3 |
| claude/C-Users-802165-.gemini | 2 |
| claude/c-Users-802165-.agents | 2 |
| claude/c-Users-802165-CLIProxyAPI | 2 |
| claude/c-Users-802165-Downloads-cursor-zh-patch | 2 |
| claude/d-DevTools | 2 |
| claude/e-Projects-backend-homing-miniapp-node-bff | 2 |
| claude/e-Projects-backend-node | 2 |
| claude/e-Projects-frontend-homing-main-base | 2 |
| claude/e-ggbdpq-guahub | 2 |
| claude/e-vibe-engineer | 2 |
| codex/E-ggbdpq-guahub-gh-fork-maka | 2 |
| zcode/C-Users-802165-.agents | 2 |

## 按月份（原始包）

- `raw/claude/2026-06.zip` — 3 MB
- `raw/claude/2026-07.zip` — 5 MB
- `raw/claude/2026-08.zip` — 13 MB
- `raw/claude/2026-09.zip` — 4 MB
- `raw/claude/2026-10.zip` — 0 MB
- `raw/codex/2026-09.zip` — 24 MB
- `raw/codex/2026-10.zip` — 39 MB
- `raw/cursor/2026-09.zip` — 0 MB
- `raw/cursor/2026-10.zip` — 2 MB
- `raw/factory/2026-10.zip` — 9 MB
- `raw/kimi/2026-07.zip` — 1 MB
- `raw/zcode/2026-10.zip` — 3 MB

## 提示词与精华

- 提示词库：prompts/prompt-library.md（132 个模板）
- 回复精华：命令与脚本 30，技术选型 14，报错解决方案 30，环境配置 30