# hunt48 / a-2953 — edit: 数字键下 JSON 数组被整体替换成对象

- issue: yetone/magpie#2953（维护者本人提出）
- 分支: `hunt48-a-edit-array`（worktree /tmp/magpie-h14，base = upstream/main `e4ac5e8712eb5750a0043bf9d206313eceadbf0d`）
- commit: `2dc57469a7ac0fe74927d1031b164f7dcf823e8d`（作者 ggbdpq <ggbdpq@gmail.com>）
- patch: `0001-edit-a-numeric-key-under-a-JSON-array-indexes-it-ins.patch`，sha256 前 16 = `331dbd962b7bcb76`
- 状态: 已提交，未推送、未发评论（按指令）

## 问题与修法

`setJSONBytes`（internal/edit/json.go）按"最长存在前缀"回退走键路径，前缀不是 object 就进标量替换分支，数组在那里被换成嵌套对象：`customModels.1` 写到 `{"customModels":[{"model":"mine"}]}` 产出 `{"customModels":{"1":{…}}}`，用户条目丢失、app 读不回（internal/sessions/droid.go:301 用 gjson ForEach 读该数组）。缺键/空数组同样变成 `{"0":{…}}`。

按维护者规格最小修复（仅动 internal/edit/json.go）：

- json.go:124 walker 加数组分支：最深存在前缀是数组且下一键为数字 → `setArrayElem`；整路径恰好命名为数组仍整体替换（合法，不变）。
- json.go:154 `setArrayElem`：`idx==len` 追加（`insertElem`），`idx>len` 报错且文件不动，`idx<n` 走到这里说明 gjson 解析不了该索引形式（前导零类），报错不猜测。非数字键下数组同样报错（今天的代码此时也无声损坏）。
- json.go:274 `insertElem`：`]` 前追加一个元素，复用 `insertKey` 的缩进机制（pretty/compact 两分支，非空时回退过 `]` 前空白再插 `,`）。
- json.go:192 `nest` 签名改 `(any, error)`：数字段建 `[]any`（只允许 0——新建容器为空，非 0 即越界），对象键不变。缺键 + `customModels.0.model` 现在产出 `{"customModels":[{"model":…}]}`。
- json.go:347-354 `matchBrace` 参数化为 `matchPair`，新增 `matchBracket`（`[`/`]`），既有调用方行为不变。

规格解读决策：缺键时创建的数组从空开始，故仅 index 0 可写、index ≥1 拒绝（`refuse creating past the array that is missing` 行）——严格按"replacing at an index that exists, appending at len, refusing past it"。

## RED / GREEN（精确）

- RED（base 上跑 TestJSONSetArrayIndex）：8 红 / 4 绿。
  - 红：append_at_the_length、append_at_the_length_through_a_deeper_key、append_into_an_empty_array、create_the_array_when_the_key_is_missing、refuse_past_the_length、refuse_a_non-numeric_key_under_an_array、refuse_creating_past_the_array_that_is_missing、append_into_a_compact_file。失败输出即 issue 引述的损坏形态（`{"customModels":{"1":{…}}}`）。
  - 绿（回归保护）：replace_the_element_at_its_index、replace_a_member_of_an_element、insert_a_member_into_an_element、a_numeric_key_under_an_object_stays_a_key。
- GREEN：修复后新表 12/12，且 `go test -tags nogui -count=1 ./internal/edit/` 全包 ok。

## 消融

- 拷贝修复后 json.go → /tmp/h14-keep/internal/edit/json.go；
- `git show upstream/main:internal/edit/json.go` 还原 → 测试保留，同 8 行红（损坏复现）；
- 拷回 → 全包 GREEN。

## 突变

- (a) 去掉 past-len 边界检查（零值增长补齐后追加）：`refuse_past_the_length` 变红 ✓（object 行保持绿）。已还原（cmp 与 h14-keep 一致）。
- (b) 把 walker 数组分支误扩为 `r.IsArray() || r.IsObject()`：`a_numeric_key_under_an_object_stays_a_key` 变红 ✓（守卫有效）。已还原，全包 ok。

## 验证矩阵

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 包测试 | `go test -tags nogui -count=1 ./internal/edit/` | ok |
| 调用方 | `go test -tags nogui -count=1 ./internal/settings/ ./internal/provider/` | ok（27.1s / 75.5s） |
| 格式 | `gofmt -l internal/edit/` | 空 |
| vet | `GOOS=darwin/linux/windows go vet -tags nogui ./internal/edit/` | exit=0 ×3，无输出 |
| build | `GOOS=darwin/linux/windows go build -tags nogui -o /dev/null .` | exit=0 ×3；darwin 有预存 cgo 警告（internal/gui/trayimage_darwin.go:112 `-Wenum-conversion`），与本次无关 |

## 调用方调查（siblings）

仓库内没有任何调用方今天写数字键路径，无行为变化面：

- internal/agent/droid.go:181 — 整体替换 `customModels` 数组（exact path），保持原行为；
- internal/agent/agy.go — `customModelsConfig.customModels`（对象语义）；internal/library/pimcp.go:379 `mcpServers.<name>`；internal/library/mcp_tools_off.go:330 `tools.<k>`；internal/library/hooks.go:723 `hooks.<event>`；internal/provider/claude_proxy_env.go:205 `env.<KEY>`；internal/agent/claude.go:1603 `env.<NAME>` — 全是对象下字符串键，不变；
- internal/settings 不经 edit 包（整体 json.Marshal 写盘）；internal/provider 经 edit（字符串键）；
- 读侧消费方 internal/sessions/droid.go:301（gjson ForEach 读 customModels 数组）正是损坏后读不回的场景，修复后写读自洽。

## 不确定项

1. 任务书说非数字键下数组"保持今天的拒绝"——实测今天并非拒绝而是无声损坏（数组→对象、无报错）；按维护者规格"绝不把数组变对象"实现为报错+文件不动。这是对任务书前提的纠正，不是偏离。
2. 缺键 + index>0 的行为是我按规格严格推导的拒绝（新建空数组 len=0），任务书只规定了 index 0 的用例；如维护者想要 `[null,…]` 补位语义需另行调整（一处 `nest` 内判断）。
3. `idx<n` 落到 `setArrayElem` 的场景（前导零如 `a.01`）选择拒绝而非猜测，错误信息已说明；gjson 与十进制解析对普通数字键一致，常规路径不可达该分支。
4. 未跑真实 Tuanjie Cowork 插件（无环境）；`settings.json` 的 `customModels[]` 形状来自 plugins#239 的描述。
5. darwin build 的 cgo 警告为预存（base 上也存在，未另行验证 base——警告文件本次未触碰）。
