# b-2969：「TOOL 使用」明细列表大小写拆分，与右侧汇总口径不一致

- issue: yetone/magpie#2969
- worktree: `/tmp/magpie-h21`，分支 `hunt49-b-tool-case`（基线 upstream/main `79160455`）
- commit: `8107cb2fb7a3bd288b95342e0182feff1602050e`（单 commit，作者 ggbdpq <ggbdpq@gmail.com>）
- patch: `0001-usage-the-tool-list-groups-tools-case-insensitively-.patch`，sha256 前 16 位 `7c99cafbb85229fe`
- 状态：完成并验证，未推送、未发评论

## 结论

左右两处聚合都在 Go 侧 `internal/sessions/stats.go` 的 `toolUse()`（GUI `assets/plugins/usage/page.js` 只渲染服务端 JSON）：

- 左侧明细 `Top`：原按原始工具名 `tools[name]` 分组 → `bash`/`Bash` 拆两行；
- 右侧图例 `Categories`：按 `ToolCategory(name)` 分组，switch 同时列出两种大小写 → 天然归并。

修法（最小，只动这一张卡的聚合）：左侧改按 `strings.ToLower(name)` 折叠分组；会话数按"每会话每折叠键计一次"去重（`Summary` 本就是每会话聚合，无需会话 id 集合、无持久化格式改动）；展示名选择：**工具名与所属类别只差大小写时用右侧图例的首字母大写形式（`bash`→`Bash`），否则用调用次数最多的原始拼写（并列取字典序，展示稳定）**。仅共享类别的不同工具（两个 `mcp__*`、`BashOutput` 与 `Bash`）保持分行。usage.jsonl 存储不动，周条形图（本就按类别键）不动。

## 测试（RED → GREEN）

新增表驱动 `TestToolUseMergesSpellings`（`internal/sessions/stats_tools_test.go`），三个用例对齐报告者的表：1400+779 归并为一行 `Bash 2179/21 会话`；一个会话同时调 `read` 和 `Read` 会话数计一次；两个 mcp 工具不误并。

- RED（消融还原旧聚合、保留测试）：

```
--- FAIL: TestToolUseMergesSpellings (0.00s)
    stats_tools_test.go:172: one tool spelled two ways ...: top [{Name:bash Category:Bash Calls:1400 Sessions:20} {Name:Bash Category:Bash Calls:779 Sessions:1}], want [{Name:Bash Category:Bash Calls:2179 Sessions:21}]
    stats_tools_test.go:172: a session that called both ways counts once: top [{Name:Read Category:Read Calls:111 Sessions:1} {Name:read Category:Read Calls:24 Sessions:2}], want [{Name:Read Category:Read Calls:135 Sessions:2}]
```

- GREEN：修复后该测试通过（`go test ./internal/sessions/ -run TestToolUseMergesSpellings -count=1`）。

## 验证矩阵

| 检查 | 命令 | 结果 |
|---|---|---|
| 新测试（修复后） | `go test ./internal/sessions/ -run TestToolUseMergesSpellings -count=1` | PASS |
| 消融（git apply -R 还原产品改动，测试保留） | 同上 | FAIL（如上 RED） |
| 恢复修复 | `git apply` 回补丁 | PASS |
| 拥有包全套件 | `go test ./internal/sessions/ -count=1` | ok (6.07s) |
| gofmt | `gofmt -l` 两个改动文件 | 干净 |
| vet | `go vet ./internal/sessions/` | 干净 |
| 构建 | `go build ./...` | 通过（仅预存 macOS cgo/ld 警告） |

GUI 侧：`node --test internal/gui/tests/sessions-overview.test.cjs` 无法运行——本机/worktree 无 `playwright` 模块（仓库无 node_modules/package.json）。该测试在浏览器内 stub `/api/sessions/overview`，不经过 Go 聚合，验证的是未被改动的渲染层，不构成阻断。

## 工件

- `2969-comment.body.md`：英文可贴评论（含报告者表、两处聚合位置、修法、RED 证据、验证表、Siblings、Not verified、完整 format-patch 嵌入；已 grep 校验零中文字符；嵌入补丁与 .patch 文件 diff 逐字节一致）
- `0001-*.patch`：`git format-patch -1` 原件

## 不确定项

- 报告者的真实数据集不可得，fixture 按其表形状构造（1400/779、按会话拆分、一会话双拼写），UI 上的真实百分比与四舍五入未复现。
- 右侧图例的 `ToolCategory` 同义词表仍按类别而非按名聚合（其职责如此）；遗留小口径差异：小写 `task` 不在 Task 分支（图例计入 "Other"，左侧明细已折叠显示为 `Task`），预存、未动，已在评论 Siblings 中说明。
- 大小写并列时展示名取字典序较小的拼写，纯确定性规则，未用真实数据校验偏好。
