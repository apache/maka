这单拆成两半考证了，结论不同：**半①（缺省降级）是声明的设计语义，交维护者拍板；半②（/v1/models 元数据）是无争议的纯增量，附 patch**。另有第③点（别名容错）的现状说明。

## 半② `/v1/models`：Catwalk 生态读的是扁平数组，已补（patch）

对照的社区惯例（Charmbracelet 源码）：

- `charm.land/catwalk` 的 `pkg/catwalk/provider.go`：`ReasoningLevels []string json:"reasoning_levels"` + `DefaultReasoningEffort string json:"default_reasoning_effort"` + `CanReason bool json:"can_reason"`——扁平字符串数组。
- Crush 的 `internal/config/reasoning_effort_test.go` 钉死了消费语义：`reasoning_levels` 为空的模型**拒绝任何 reasoning_effort**（"model without reasoning levels rejects any effort"），这正是报告者观察到的「视为空 → 主动剔除」。

magpie 现状（`internal/gateway/gateway.go` 的 `modelObject`）：有 `reasoning`（布尔，已覆盖报告者建议里的 `reasoning: true`）和 `supported_reasoning_levels`（`[{"effort":...}]` 对象数组，跟随 Codex catalog 惯例），没有扁平 `reasoning_levels`。

**修法**：`modelObject` 补一个 `reasoning_levels` 扁平字符串数组，内容与 `supported_reasoning_levels` 同源同序（`e.Efforts` 原样，含 `none` 的照实导出——DeepSeek 这类 toggle 型模型的 `none` 是 models.dev 验证过的真实档位，#1098）。**纯增量**：既有字段一律不动；magpie 自家消费端 `catalog.levelsOf` 本来就兼容两种形状（对象/扁平），remote-magpie、Desktop、Science 各路径不受影响。空档位模型输出 `[]` 不输出 `null`。

`default_reasoning_effort` **没有补**：magpie 的模型目录里没有「模型默认档位」这个数据源（`provider.Entry` 只有 `Efforts` 列表和 `Reasoning` 布尔），填什么都是编造——DeepSeek 的真实默认是非思考，填 `high` 反而说谎。如果维护者想补，需要先定数据从哪来（models.dev？用户设置？）。

一个诚实的限定：Crush 的通用 `DiscoverModels`（`internal/discover/discover.go`）只解析 `/v1/models` 的 `id/object/created/owned_by`，**不读** reasoning 字段——所以本 patch 对「Crush 从零发现」的通道不生效；它救的是**读这些字段的框架/客户端**（报告者的 Catwalk 类场景，字段对照其 schema），以及手动把 magpie 模型配置进这类客户端时的校验路径。

## 半① 缺省 `reasoning_effort`：机制链考证，不硬凑

代码链（`internal/gateway/`）：

1. `chat.go` `parseChat`：客户端没带 `reasoning_effort` → `Effort == ""`、`Thinking == false`、`ThinkOff == false`。
2. 发送侧 `chatBody`：只在 `r.Effort != ""` 时发 `reasoning_effort` 键——**缺省时 magpie 什么都不发**，没有主动注入关闭。
3. 所以「退化为纯文本」是上游自己的默认（DeepSeek 的 chat 端点默认非思考）叠加「客户端被半②的空字段剥了 effort」。
4. `group/auto-*` 组的 auto 分类器同样不跑：`rules.go` 的 `effort := g.Effort == provider.EffortAuto && hit.Effort != "" && !req.ThinkOff`，两处注释都声明了这是语义（"the turn asks its model for that much reasoning, **where the agent asked for some**"；分类器只在 "a turn the agent asked to reason in" 被咨询）。#2247 修复（`none` 不白咨询分类器）用的就是同一道门——「客户端明确要思考，magpie 才代选档位」。

把「缺省=非思考」改成「推理模型缺省=默认思考」是产品语义变更：它影响**所有**不带 effort 的客户端（费用与首字延迟整体上移），且组的 `effort` 现在只有 `auto`/跟随 agent 两种取值（`group.go`：`a group's effort is "auto" or left to the agent`），加「组固定档位」或「网关级缺省」都是新开关。这个方向我不动码，交维护者拍板。另说明：半②修好后，Catwalk 类客户端会保留并发送 `reasoning_effort`，报告者的场景直接恢复思考——兜底不再是必需。

## ③ `thinking: true` / `enable_thinking` 别名

现状：Chat 入口只解析 `reasoning_effort`；`thinking`/`enable_thinking` 目前是作为未知键被剥离（`withoutFields`），不解析。归一化的歧义在映射目标（`thinking: true` → 哪个档位？各家词汇表不同），与半①同属产品决策，一并交维护者。

## Verification

| 检查 | 结果 |
| --- | --- |
| 新测试 `TestModelsListFlatReasoningLevels`（修前） | 红：4 处断言失败，`reasoning_levels <nil>`，与 issue 描述逐字对应 |
| 新测试（修后） | 绿 |
| `TestModelsListReasoning`（同域守护，对象数组形状） | 绿 |
| `go test -tags nogui -p 2 -count=1 ./internal/gateway/` 全量 | ok（329s） |
| `go test -tags nogui -p 2 -count=1 ./internal/catalog/`（消费端 `levelsOf`） | ok |
| `gofmt -l` 两改动文件 | 干净 |
| `GOOS=linux/amd64 GOOS=windows/amd64 GOOS=darwin/arm64 go vet -tags nogui ./internal/gateway/` | 三平台全过 |
| `go build -tags nogui .` | 成功（仅预存 cgo -Wenum-conversion 警告） |

没跑的：真机 Crush/Catwalk 端到端（本机无这些客户端；字段形状对照的是两者源码）；`-race`（改动是纯 JSON 组装，无并发面）。macOS 本机 go 1.25 工具链 + GOTOOLCHAIN=auto。

patch（基线 a69cd070，`modelObject` 一处 + 测试一个，共 98 行）：

<details>
<summary>format-patch 全文</summary>

```
From 74dde58178f5dae3a0a9381e4e46e6210af8254d Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 17 Oct 2026 04:20:43 +0800
Subject: [PATCH] gateway: the model list says each model's reasoning levels as
 plain names, too (#2576)

Clients of the Catwalk schema (Crush and kin) read reasoning_levels, a
flat array of names, to know which reasoning efforts a model takes, and
strip the reasoning effort from requests to a model that names none.
The list only said the per-level objects (supported_reasoning_levels),
which such a client reads as none. The objects stay; the flat names
carry the same efforts, in the same order.

Fixes #2576
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go      | 10 +++-
 internal/gateway/gateway_test.go | 89 ++++++++++++++++++++++++++++++++
 2 files changed, 98 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index d9a5adc1..79ee78dd 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -833,8 +833,16 @@ func modelObject(e provider.Entry) map[string]any {
 	for _, effort := range e.Efforts {
 		levels = append(levels, reasoningLevel{Effort: effort})
 	}
+	// the same levels as plain names: clients of the Catwalk schema (Crush
+	// and kin) read the flat array to know which reasoning efforts a model
+	// takes, and strip the reasoning effort from requests to one that
+	// names none (#2576). The objects stay for the readers the list
+	// already has, magpie's own included (levelsOf reads either)
+	flat := make([]string, 0, len(e.Efforts))
+	flat = append(flat, e.Efforts...)
 	m := map[string]any{"id": e.ID, "object": "model", "type": "model", "created": 0, "created_at": "2025-01-01T00:00:00Z",
-		"owned_by": e.Provider.ID, "display_name": e.PlainName(), "reasoning": e.Thinks(), "supported_reasoning_levels": levels}
+		"owned_by": e.Provider.ID, "display_name": e.PlainName(), "reasoning": e.Thinks(), "supported_reasoning_levels": levels,
+		"reasoning_levels": flat}
 	// the window, as the names clients read it by: a group's context
 	// (magpie group set … context=) included
 	if e.Context > 0 {
diff --git a/internal/gateway/gateway_test.go b/internal/gateway/gateway_test.go
index bb063186..4545409a 100644
--- a/internal/gateway/gateway_test.go
+++ b/internal/gateway/gateway_test.go
@@ -997,6 +997,95 @@ func TestModelsListReasoning(t *testing.T) {
 	}
 }
 
+// TestModelsListFlatReasoningLevels checks the list also says each model's
+// reasoning levels as a flat array of names (reasoning_levels), beside the
+// per-level objects (supported_reasoning_levels): clients of the Catwalk
+// schema (Crush and kin) read the flat array to know which reasoning
+// efforts a model takes, and one that names none has them stripped
+// (#2576). The objects stay for the readers magpie's list already has.
+func TestModelsListFlatReasoningLevels(t *testing.T) {
+	fresh(t)
+	if err := os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	data := `{"a":{"models":{
+		"sol":{"id":"sol","reasoning_options":[{"type":"effort","values":["low","medium","high","max"]}]},
+		"thinker":{"id":"thinker","reasoning_options":[{"type":"toggle"}]}}},
+		"b":{"models":{
+		"sol":{"id":"sol","reasoning_options":[{"type":"effort","values":["medium","high"]}]}}}}`
+	if err := os.WriteFile(catalog.CachePath(), []byte(data), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	catalog.Reset()
+	t.Cleanup(catalog.Reset)
+	for _, id := range []string{"a", "b"} {
+		if err := provider.Save(provider.Provider{ID: id, Name: id, Catalog: id, Key: "k", Chat: "http://127.0.0.1:1/v1"}); err != nil {
+			t.Fatal(err)
+		}
+	}
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/v1/models", nil))
+	if rec.Code != http.StatusOK {
+		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
+	}
+	var response struct {
+		Data []map[string]any `json:"data"`
+	}
+	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
+		t.Fatal(err)
+	}
+	want := map[string]string{
+		"a/sol": "low,medium,high,max", "b/sol": "medium,high", "group/auto-sol": "medium,high",
+	}
+	flatFound := map[string]bool{}
+	for _, m := range response.Data {
+		id, _ := m["id"].(string)
+		expected, ok := want[id]
+		if !ok {
+			continue
+		}
+		flatFound[id] = true
+		levels, ok := m["reasoning_levels"].([]any)
+		if !ok {
+			t.Errorf("%s: reasoning_levels %#v; want an array", id, m["reasoning_levels"])
+			continue
+		}
+		names := make([]string, 0, len(levels))
+		for _, level := range levels {
+			name, _ := level.(string)
+			names = append(names, name)
+		}
+		if got := strings.Join(names, ","); got != expected {
+			t.Errorf("%s: reasoning_levels %q; want %q", id, got, expected)
+		}
+		// the per-level objects stay, for the readers the list already has
+		objs, ok := m["supported_reasoning_levels"].([]any)
+		if !ok || len(objs) != len(levels) {
+			t.Errorf("%s: supported_reasoning_levels %#v; want %d objects beside the flat names", id, m["supported_reasoning_levels"], len(levels))
+		}
+	}
+	for id := range want {
+		if !flatFound[id] {
+			t.Errorf("%s: no reasoning_levels row checked", id)
+		}
+	}
+	// a toggle-only model reasons but has no levels: the array is there
+	// and empty, never null
+	for _, m := range response.Data {
+		if m["id"] != "a/thinker" {
+			continue
+		}
+		switch v := m["reasoning_levels"].(type) {
+		case []any:
+			if len(v) != 0 {
+				t.Errorf("a/thinker: reasoning_levels %v; want empty", v)
+			}
+		default:
+			t.Errorf("a/thinker: reasoning_levels %#v; want an empty array", m["reasoning_levels"])
+		}
+	}
+}
+
 func TestGeminiClientChatUpstream(t *testing.T) {
 	f := &fake{t: t, reply: sse(
 		`data: {"id":"c1","model":"m1","choices":[{"delta":{"role":"assistant","reasoning_content":"think"}}]}`,
-- 
2.50.1 (Apple Git-155)


```

</details>

fork 分支：[`ggbdpq/magpie` `hunt/2576-models-metadata`](https://github.com/ggbdpq/magpie/tree/hunt/2576-models-metadata)（`74dde581`）。如采纳，请保留作者或加 Co-authored-by。

Generated-by: GLM-5.3-Flash (ZCode)
