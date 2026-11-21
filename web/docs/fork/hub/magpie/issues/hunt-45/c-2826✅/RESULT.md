# hunt45-c-2826 本地记录（Antigravity 数组 schema 必带 items）

- 日期：2026-10-18
- issue：yetone/magpie#2826（Claude Code 的 `prefixItems` tuple 被 `plainSchema` 剥离后，内层数组无 `items`，Google 400 `...where.items.items: missing field`）
- worktree：`/tmp/magpie-h6`，分支 `hunt45-c-antigravity-array-items`，base upstream `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`
- 提交：`d79961fbbc3041d2165178df3128d0ca43cb40c1`（作者 ggbdpq <ggbdpq@gmail.com>，2 文件 +68 行）
- patch：`0001-gateway-an-Antigravity-schema-s-array-always-says-it.patch`，sha256 前 16 `b8605f312d27867a`

## 改动

- `internal/gateway/codeassist.go`（+32）：
  - `firstSays` 闭包（:652）：tuple 成员里第一个"说了点什么"的 schema 对象（跳过 `{}` 与非对象）；
  - `plainSchema` walk 的 map 分支、类型推断之后（:807-828）三条规则：
    1. `items` 是数组（draft 07 tuple）→ 收缩为第一个有效成员；
    2. `type:"array"` 且 items 缺、原节点有 `prefixItems` → 第一个有效成员 walk 后充当 items；
    3. 仍缺 → 注入 `{"type":"string"}`。
- `internal/gateway/plain_schema_test.go`（+36）：`TestPlainSchemaArrayAlwaysHasItems`，4 个子用例（报告者原形 / 从未有 items / tuple items / 全空 tuple）。

## 调用链与 siblings（核实结论）

- `plainSchema` 唯一非测试调用方：codeassist.go:356，`ag`（Antigravity）分支——即报告路径。
- 非 `ag` 分支（:358 `parametersJsonSchema`）：Gemini CLI（gemini.go:114）与 Vertex（vertex.go:23）经 `geminiRequest` → `buildCodeAssistSent`，schema 原样透传，tuple 合法，未改。
- `responseJsonSchema`（:411）原样透传，非 function declaration，报告未覆盖，未改（已写入 comment 的 Siblings/Not verified）。
- deepseek_schema.go:101 / kimi_schema.go:104 / oneof_schema.go:74 只是遍历时穿过 `prefixItems` 找各自要修的关键字，保留 tuple，vendor 收完整 JSON Schema，未改。

## RED / GREEN / 消融 / 变异证据

- 首轮 RED：4 子用例全红（当时用例 1 的 want 串少一个闭括号，exp=nil，证据不纯；修正 want 后由消融重取干净证据）。
- 消融（upstream 代码 + 修正后测试）：4 子用例全红，用例 1 got `"items":{"type":"array"}` 正是 400 形状；恢复 → 绿。
- 变异 (a) 删默认注入：`an_array_that_never_said_items` 与 `a_tuple_of_nothing_gets_the_default` 红（后者同样落到默认），另两例绿。
- 变异 (b) 删 tuple 收缩：仅 `a_tuple_items_collapses_to_one` 红（items 保持数组）。

## 验证矩阵（实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 目标 | `go test -tags nogui -count=1 -run 'TestPlainSchema\|TestCodeAssist\|TestAntigravity' ./internal/gateway/` | ok 1.017s |
| 整包 | `go test -tags nogui -count=1 ./internal/gateway/`（后台落盘 /tmp/h6-full-gateway.log） | ok 327.237s，exit=0，无预存失败 |
| 竞态 | `go test -race -tags nogui -count=1 -run 'TestPlainSchema' ./internal/gateway/` | ok 2.143s |
| 格式 | `gofmt -l internal/gateway/` | 空 |
| vet | darwin / GOOS=linux / GOOS=windows，`-tags nogui` | 三平台全过 |
| 构建 | darwin `./...`、linux `./...`、windows `-o /dev/null .` | 全过；darwin 有预存 cgo 警告（internal/gui/trayimage_darwin.go 的 -Wenum-conversion，非本补丁文件，非错误） |

## 未验证 / 不确定项

- 未发真实 Antigravity/Google 请求，400 措辞引自报告；复现是 schema 级断言。
- 恢复策略（首个有效 prefixItems 成员 / `{type:string}` 默认）是报告的建议方案，可能丢 tuple 后续成员的约束（如第二个成员的 enum）；已在 comment 的 Not verified 里向维护者标明，换方案是同块两行改动。
- 本机 zsh 配置在每条命令输出 `_encode/_decode` 报错（用户 shell 环境问题，与仓库无关，已 grep 过滤）。

## 产出

- `2826-comment.body.md`：英文 post-ready，含完整 format-patch（details + ```patch 围栏），`LC_ALL=C grep -nP '[\x{4e00}-\x{9fff}]'` 无中文字符（exit 1）。
- 未 push、未发评论——仅本地。
