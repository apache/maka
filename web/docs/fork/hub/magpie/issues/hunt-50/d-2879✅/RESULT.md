# hunt50-d-2879：Library → RTK 关闭 Claude 开关报「hook 仍在 Claude 里」

## 结论

已修复并提交。根因是 magpie 的「检测」与「移除」不对称：`has` 对 `~/.claude/settings.json` 整个文件做原始字节搜索 `rtk hook claude`（任何 hook 事件下都算开），而 `remove` 只在 `hooks.PreToolUse` 一个键下删。rtk 1.0.1 的安装器在用户 rtk 管线含 after_tool 规则（`rtk:posthook`）时还会把同一条命令写进 `hooks.PostToolUse`，它自带的卸载器则扫 `PreToolUse`、`PostToolUse`、`SessionStart` 三个键。任一额外事件下有条目时，magpie 关闭后复查仍命中 → `SetRTK` 报 `rtk's hook is still in Claude`（中文 i18n 即「hook 仍在 Claude 里」），开关停在开。上报者第二条诉求（失败后前端开关回滚）属前端，本次未做，已在评论中说明。

## 改动

- `internal/library/rtk.go`：claude spec 的 `remove` 增加对 `hooks.PostToolUse`、`hooks.SessionStart` 的 `dropHook`（同一 mark `rtk hook claude`，绝对路径变体如 `/opt/homebrew/bin/rtk hook claude` 因子串包含同样命中），与 rtk 自身卸载器扫的事件集对齐。用户自己的 hook（fixture 中 PostToolUse 的 `lint`、SessionStart 的 `greet`）保留。
- `internal/library/rtk_test.go`：新增 `TestRTKRemoveClaudeOtherEvents`（#2879 夹具：三个事件下都有 rtk 条目 + 用户 hook + `model` 键 + 关闭后行状态读作 off）。

## 依据（rtk v1.0.1 源码，tag v1.0.1）

- `src/hooks/init/claude.rs`：`patch_settings_json_command` 按 `required_claude_events_scoped` 写事件；注释原文 "enabling `rtk:posthook` adds PostToolUse"；`remove_hook_from_json` 遍历 `[PRE_TOOL_USE_KEY, POST_TOOL_USE_KEY, SESSION_START_KEY]`。
- `src/hooks/constants.rs`：`PRE_TOOL_USE_KEY="PreToolUse"`、`POST_TOOL_USE_KEY="PostToolUse"`、`SESSION_START_KEY="SessionStart"`、`CLAUDE_HOOK_COMMAND="rtk hook claude"`、`CLAUDE_PRE_MATCHER="Bash"`。
- 兄弟 agent 核对：codex 只扫 `PreToolUse`、gemini 只 `BeforeTool`、cursor 只 `preToolUse`（flat），与 magpie 现有 dropHook 键一一对应，无漂移，未改。

## RED / GREEN / 消融 / 变异

- RED（基线 + 新测试）：`--- FAIL: TestRTKRemoveClaudeOtherEvents … rtk's hook is still in Claude Code`。
- 消融：撤掉产品改动（保留测试）→ 同样 RED；恢复 → GREEN。
- 变异 1（容错匹配改严格相等 `==`）：RED（绝对路径条目漏删）。
- 变异 2（dropHook 删掉所有条目，过宽）：RED（守卫触发：用户 PostToolUse `lint`、SessionStart `greet` 被误删；两条守卫断言都在新测试里，另有 TestRTKRemove 的 PreToolUse `lint` 守卫）。

## 验证矩阵

| 检查 | 命令 | 结果 |
|---|---|---|
| 新测试（基线） | `go test ./internal/library/ -run TestRTKRemoveClaudeOtherEvents` | FAIL（上报行为） |
| 新测试（修复后） | 同上 | ok |
| 拥有包全量 | `go test ./internal/library/` | ok 75.6s |
| gofmt | `gofmt -l internal/library/` | 干净 |
| vet | darwin / linux / windows `go vet ./internal/library/` | 全过 |
| 拥有包构建 | `go build ./internal/library/` × 3 平台 | 全过 |
| 全仓构建 | `go build ./...` | darwin ok（预存 cgo 告警）；windows ok；linux 失败于模块缓存里 wails v3 依赖（GTK/cgo 环境，预存、与本 diff 无关；internal/library 本身 linux 可构建） |

## 提交与产物

- 分支 `hunt50-d-rtk-hook-off`（base upstream/main `7916045591c318c84fa894022516a7ebffc9a91e`），worktree `/tmp/magpie-h28`。
- Commit：`49613be9b1fd3300d54267e5a12b264d6dfff469`，作者 ggbdpq <ggbdpq@gmail.com>。
- Patch：`0001-library-turning-RTK-off-matches-the-hook-Claude-s-se.patch`，sha256 前 16 位 `04d2be5b2c085ddb`。
- `2879-comment.body.md`：英文 post-ready，含完整 format-patch，grep 校验零中文。

## 不确定项

- 未运行真实 rtk 二进制；rtk 1.0.1 写入形状取自其 v1.0.1 源码与上报环境（macOS、rtk 1.0.1）。上报者文件里具体是 PostToolUse 还是 SessionStart 条目无法从报告判定，修复覆盖 rtk 自身卸载器扫的全部三个事件。
- rtk 1.0.1 的 `SessionStart` 条目是否曾携带 `rtk hook claude` 命令（还是 legacy `rtk-rewrite.sh` 脚本路径，后者不含 `rtk hook claude` 子串、本就不触发 `has`）无法仅从源码钉死；扫该键与 rtk 卸载器行为一致，即便多余也无代价。
- 前端失败回滚（上报诉求 2）未实现，评论中已注明。
