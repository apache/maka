# #3173 处理报告（hunt57-b）

日期：2026-10-21。分支 `hunt57-b-antigravity-items`（独占 worktree `/tmp/magpie-h83`，base `f5b01574` = upstream/main）。仅本地修改，未 push、未发帖。

## 产物

- head SHA：`b7a4095176e1501a8f24931f26de63cecebff810`（首行 `gateway: a type that folds off array leaves a tool schema's items behind, so Antigravity takes the turn (#3173)`，作者核验 `ggbdpq <ggbdpq@gmail.com>`）
- patch：本目录 `0001-gateway-a-type-that-folds-off-array-leaves-a-tool-sc.patch`，sha256 前 16 = `450898304acc4437`
- 英文帖：本目录 `issue-body.md`（零中文已扫描核验，模型名仅在 patch 内 Generated-by）
- commit message：`commit-msg.txt`；gateway 全包日志：`gateway-full.log`
- diff：`internal/gateway/codeassist.go` +7 行（含注释）；`plain_schema_test.go` +52 行（两个测试）

## 关键发现：简报前提被实证推翻

简报/主线程结论称「plainSchema 没处理 oneOf/anyOf，尤其出现在 items 值上」。**实测为假**：

- anyOf/oneOf 分支早已存在（`git log -S 'anyOf / oneOf'` → 637b2458，v0.1.100 之前；报告者的 0.1.1306/0.1.1308 都含此分支）。
- 用报告者两个节选形状（`items` 直接挂 `oneOf`、`anyOf` 包 `oneOf`）跑 base 的 plainSchema，输出全部正确折叠、每个 `items` 值有确定 `type`、无 union 键残留（探针证据，后固化为守卫测试 `TestPlainSchemaFoldsAUnionOnItems`，base 上绿）。

真正在 base 复现 400 签名的形态：**`type` 列表折叠后保留 `items`**。`{"type":["string","array"],"items":{...}}` → `{"type":"string","items":{...}}`——string 节点挂 `items`，正是 `$type == Type.ARRAY` 断言失败；嵌在 array 属性下，失败路径恰为报告 400 里的两级 `items.items`。此为 #3121（open）的根因，#3173 的 400 是它在嵌套层的同一表现。报告者真实 REA schema 在 issue 里是节选，无法确认其确切入口形状；已确认的是：这是 plainSchema 仍可能在非 array 节点上发出的唯一带 `items` 的形态，且其断言失败与报告签名逐字节吻合。

## 假设与兜底策略取舍

- 兜底选**删**而非**补**：折叠后类型非 array 时 `items` 是无权携带的杂散关键字，删除是纯删减，与函数「cut down」设计一致；改折叠优先级（列表含 array 就选 array）会改变模型看到的类型（array 替代 string），重开折叠语义，弃用。
- 修复位置选在 walk 所有分支（$ref/allOf/union/普通节点）唯一汇合的 type 推断块之后（`codeassist.go:797`）——一处覆盖全部路径；union 分支经 pick walk 后同样汇入，无需单独处理。
- 只删 `items`，不动 `minItems`/`maxItems`：全部 400 证据只点名 items 路径，无 minItems 断言失败的证据，不扩面。
- type 缺失、仅有 `items` 的节点先按既有规则推断为 `array` 再判断，合法形态零影响。

## RED / GREEN

RED（base，`go test ./internal/gateway/ -run TestPlainSchema -count=1 -v`）：

```text
=== RUN   TestPlainSchemaDropsItemsOffAnArray
    plain_schema_test.go:63: got {"properties":{"actions":{"items":{"items":{"type":"string"},"type":"string"},"type":"array"},"disease":{"items":{"minLength":1,"type":"string"},"type":"string"},"functions":{"items":{"items":{"type":"string"},"type":"string"},"minItems":1,"type":"array"}},"required":["disease"],"type":"object"}
--- FAIL: TestPlainSchemaDropsItemsOffAnArray (0.00s)
FAIL
```

同跑中 `TestPlainSchemaKeepsOnlyWhatAntigravityTakes`、`TestPlainSchemaFoldsAUnionOnItems` 均 PASS（守卫本就该绿）。

GREEN（修复后同命令）：3/3 PASS（原文在 /tmp/magpie-h83-green.txt，`ok github.com/yetone/magpie/internal/gateway`）。

## 消融

1. 还原 codeassist.go 到 base → 上红（FAIL 原文同 RED）→ 恢复修复 → 3/3 绿。
2. 变异（条件 `!= "array"` 反转为 `== "array"`，删除落在合法 array 上）→ 三测齐红：
   - KeepsOnly：`"tags":{"minItems":1,"type":"array"}`（items 被误删）
   - Drops：`"actions":{"type":"array"}`（items 被误删）且 `"disease":{"items":{...},"type":"string"}`（杂散仍在）
   - Folds：四个属性 items 全被误删
   还原后 3/3 绿。`git diff --stat`：codeassist.go 恰 +7 行。

## Watched 三查

- (a) 打破回红：消融 1、2 两次双向完成。
- (b) 其他翻译路径（`rg 'oneOf|anyOf' internal/ --type go` 非 test）：
  - `codeassist.go:356` plainSchema 唯一调用点 = 唯一 Antigravity/Code Assist 出站路径 → 已修。
  - `codeassist.go:358` 非 ag 路径发 `parametersJsonSchema` 原样（Gemini 接受完整 JSON Schema）→ 不改。
  - `gemini.go:345`、`prompt.go:1045` 均为入站解码 → 不改。
  - `deepseek_schema.go:101`、`kimi_schema.go`（该家自带适配与拒收规则，如拒绝 anyOf 旁挂 type）→ 不改，越界。
  - `oneof_schema.go`（xgrammar 路由 oneOf→anyOf 改名）、`object_root.go`/`anthropic.go:1645`/`provider/grok.go`（根联合包裹）→ 正交，不改。
- (c) 畸形输入：`oneOf:[]`→`{"type":"string"}`；非数组 `oneOf`→退化 `{}`（预存行为）；boolean/`null`/空对象 `items` 不 panic，string 上 boolean items 被新规则正确删除；垃圾 `type:{}` 挂 items→items 删除；`["null","array"]`→nullable array 保留 items；root 层杂散 items 同样删除；畸形 JSON 原样返回。全程无 panic。

## 矩阵

| 项 | 命令 | 结果 |
|---|---|---|
| 定向 | `go test ./internal/gateway/ -run TestPlainSchema -count=1 -v` | 3/3 PASS |
| race | `go test -race ./internal/gateway/ -run TestPlainSchema -count=1` | ok |
| gofmt | `gofmt -l`（两改动文件） | 无输出 |
| vet | `go vet ./internal/gateway/` | exit 0 |
| build | darwin/arm64 `./...`；linux/amd64 `-tags nogui`；windows/amd64 `-tags nogui` | 全过（darwin 仅为预存链接告警） |
| gateway 全包 | `go test ./internal/gateway/ -p 1 -timeout 30m -count=1` | ok 329.971s（gateway-full.log） |

## 不确定项

- 未对真 Antigravity 账号端到端验证（无账号）；验证止于 schema 级 + gateway 全包。
- 报告者完整 REA schema 不可得，其 400 的确切入口形状（是否经 `type` 列表折叠进入）无法回放确认；已确认修复后 plainSchema **不可能**再发出任何非 array 节点上的 `items`，即 400 谓词在该函数输出侧已无触发面。
- `minItems`/`maxItems` 挂在非 array 折叠节点上是否也会被 Gemini 拒（#3121 的 400 未点名）未验证，本补丁未动。
- #2784/#2826（缺 `items` 的「missing field」谓词）是另一半问题，需「补 items」，本补丁有意不做。
