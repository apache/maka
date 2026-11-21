> **2026-10-17 状态更正：暂停产品补丁推进，尚未同步 GitHub。** 维护者在真实 Codex 后端对本帖重复输出形状测试得到200，指出所引400是 `store:true` / `previous_response_id` 的有状态重放，与本帖无状态relay不同。以下保留原始分析与构造测试，**不再作为“OpenAI必回400”或待合入修复的证据**。没有真实失败前丢第二份结果会改写用户数据；等待客户端/版本、上游类型、实际请求与错误原文。维护者明确先保持issue打开，不重复催收或代关。参见[维护者回复](https://github.com/yetone/magpie/issues/2221#issuecomment-6174842444)与[本轮待发布稿](../quality-20261017/2221/issue-body.md)。

# gateway: Responses 直通重复结果是否导致真实上游失败，等待实际请求证据

分支 `hunt21-w1-dup-answer`（head `84c23892`，基于 upstream/main `743fcc035`（今日 tip；gateway 目录与我分支基点 `a36319d6` 零 diff，已核对））。发帖前已再 fetch upstream。

## 现象

客户端的会话历史里，同一个 `call_id` 带了两条 `function_call_output` 时——真实形状：human-in-the-loop 审批流把「call 的审批」和「output」分开持久化，恢复会话时重放进 input；vercel/ai#13307 记录了 SDK 层的真实复现，OpenAI Responses API 对它回 400 `invalid_request_error`：

> Duplicate item found with id fc_****. Remove duplicate items from your input and try again.

社区同型报告（openai community #1373703，"Duplicate item found with id msg_…"）也是历史重放触发。这个 400 会一直重复：那两条 output 在客户端历史里一直在，之后每一轮都被上游拒。

magpie 的 Responses relay（`/v1/responses` 直通上游）把两条 output 原样转发，客户端拿到上游的 400。而同一个形状交给 Chat 上游会被 `pairToolMessages` 修掉（"a second answer to the same call is dropped: the first answer stands"，chat.go），交给 Messages 上游会被 `pairToolBlocks` 修掉（"a second answer: the first stands"，anthropic.go:1037）。relay 面自己缺 result 会补（#1341），重复却放行——四条「修交换」的边界里唯一一条漏的，且它正对着对重复零容忍的那个 API。

## 最小复现

新增 `internal/gateway/pair_tool_items_test.go`：

- `TestPairToolItemsDropsASecondAnswer`（单元 + 全链路场景）；
- `TestResponsesRelayDropsASecondAnswer`（走完整网关：`/v1/responses` → 假上游，断言上游只收到一条 `call_a` 的回答）。

修前（仅还原 `internal/gateway/responses.go`）：

```text
--- FAIL: TestPairToolItemsDropsASecondAnswer (0.00s)
    pair_tool_items_test.go:125: the second answer stood: [map[arguments:{} call_id:c1 name:echo type:function_call]
      map[call_id:c1 output:first type:function_call_output] map[call_id:c1 output:second type:function_call_output]]
--- FAIL: TestResponsesRelayDropsASecondAnswer (0.36s)
    pair_tool_items_test.go:202: 2 answers for call_a reached the upstream: {"model":"m1","stream":true,"input":[
      …,{"type":"function_call_output","call_id":"call_a","output":"first result"},
        {"type":"function_call_output","call_id":"call_a","output":"second result"},…]}
```

修后两个测试绿：只留第一条，第二次及以后的回答（function 与 custom 两种）都丢弃；不同 call_id 的回答互不影响；run 末尾的 synthetic 补齐照旧。

## 根因

`internal/gateway/responses.go` 的 `pairToolItems`：

- 初扫描只把每条 output 记进 `answered`，用于决定「哪些 call 要补 synthetic」；主循环里对每条 input 无条件 `out = append(out, raw)`——重复回答从不丢弃。
- 修它的过程中还发现原函数的守卫 `if len(out) == len(input) { return body }` 不可靠：丢一条重复回答、又在 run 末尾补一条 synthetic 时长度恰好相等，改动被误判为「没动」而整单退回原 body（新单测的并行场景正好构造出这个组合）。已换成显式 `changed` 标志。

## 修法

`pairToolItems` 主循环里用 `seen` map 逐条判定：同 `call_id` 的 `function_call_output` / `custom_tool_call_output` / `tool_search_output` 第二次出现即丢弃，第一条算数——与 `pairToolMessages`、`pairToolBlocks` 同一语义。synthetic 补齐与 flush 时机不变。

不改动：`pairToolMessages`、`pairToolBlocks`、`orphanedToolOutputs`、`joinToolRuns`、设计页（行为收敛到两个兄弟已有的语义，文档对 relay 修补的描述未展开到这个分支）。既有测试 `TestPairToolItemsAnswersALoneCall`、`TestResponsesRelayKeepsAToolRunTogether` 等全部保持通过。

## 验证

| 命令 | 结果 |
| --- | --- |
| 修前（stash `responses.go`）跑两个新测试 | FAIL，输出如上（上游实收 2 条回答） |
| 修后同测试 | PASS |
| `go test -tags nogui -p 2 -count=1 -run 'TestPairToolItems\|TestResponsesRelay\|TestJoinToolRuns\|TestOrphanedToolOutputs' ./internal/gateway/` | ok |
| `go test -tags nogui -p 2 -count=1 ./internal/gateway/`（沙盒 HOME，全包） | ok（见文末说明） |
| `gofmt -l internal/` | 无输出 |
| `go vet -tags nogui ./internal/gateway` | 通过 |
| `go build -o /dev/null .`；`GOOS=linux go build -tags nogui -o /dev/null .`；`GOOS=windows go build -o /dev/null .` | 三平台 OK（darwin 仅已知的 cgo `-Wenum-conversion` 与 ld 警告） |

## 没跑什么

- **没有真实 OpenAI 凭据**：上游 400 的引文来自 vercel/ai#13307 与 openai community 帖，未在本机对着 api.openai.com 复现；火山 coding plan（#1341 的形状）对重复 chat `tool_call_id` 的反应也未实测——修复不依赖它（第一条已把交换修成上游接受的形状）。
- 「哪个 magpie 客户端在什么操作序列下会发出双份 output」没有逐一验证：vercel/ai 的 approval-重放是同类 SDK 的实证，magpie 侧的 Codex/OpenCode/Pi 未做逐个排查。即便没有客户端发得出这个形状，补上这条边界也只是让四条「修交换」的路径语义一致。
- 未跑 `-race`、GUI 与其他包的全量。

patch（`git format-patch -1 --stdout`，即下一条 commit `84c23892`）：

<details><summary>84c23892 gateway: a Responses relay's duplicated tool answer is dropped…</summary>

```patch
From 84c23892692523dbda9597091ec0dea3f5ce2808 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 14 Oct 2026 23:41:55 +0800
Subject: [PATCH] gateway: a Responses relay's duplicated tool answer is
 dropped, the first standing, instead of OpenAI's 400 "Duplicate item found"
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A client replaying a history that holds a call's approval and its output
twice sends both (vercel/ai #13307: "Duplicate item found with id fc_….
Remove duplicate items from your input and try again"), and pairToolItems
passed the duplicate on: it mends a call no result answers (#1341) but
kept every answer it saw. The Chat build drops a second answer
(pairToolMessages: "a second answer to the same call is dropped: the
first answer stands") and the Messages build does too (pairToolBlocks:
"a second answer: the first stands"); the Responses relay was the one
boundary that let it through, and the relay serves the one API whose
answer to it is a 400 the client can do nothing about.

Now a second answer to a call an answer ahead in the input gave is
dropped, whatever its kind (function_call_output, custom_tool_call_output,
tool_search_output), with the run's synthetic results still flushed after
its last answer. The old `len(out) == len(input)` guard read a request
that lost an answer and gained a synthetic one as untouched; `changed`
replaces it.

Not changed: pairToolMessages, pairToolBlocks, orphanedToolOutputs,
joinToolRuns, the docs. TestPairToolItemsAnswersALoneCall,
TestResponsesRelayKeepsAToolRunTogether and the rest of the package's
pairing tests hold.

Run: go test -tags nogui -p 2 -count=1 -run 'TestPairToolItems|TestResponsesRelay|TestJoinToolRuns|TestOrphanedToolOutputs'
./internal/gateway (ok); TestPairToolItemsDropsASecondAnswer and
TestResponsesRelayDropsASecondAnswer fail on the unfixed pairToolItems
(2 answers reach the upstream); gofmt -l internal/ clean; go vet -tags
nogui ./internal/gateway clean; builds darwin, GOOS=linux nogui,
GOOS=windows.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/pair_tool_items_test.go | 94 ++++++++++++++++++++++++
 internal/gateway/responses.go            | 30 ++++++--
 2 files changed, 119 insertions(+), 5 deletions(-)

diff --git a/internal/gateway/pair_tool_items_test.go b/internal/gateway/pair_tool_items_test.go
index fd0a96fd..ae7bbede 100644
--- a/internal/gateway/pair_tool_items_test.go
+++ b/internal/gateway/pair_tool_items_test.go
@@ -108,3 +108,97 @@ func TestResponsesRelayAnswersALoneCall(t *testing.T) {
 		t.Fatalf("the lone call went unanswered: %s", f.got)
 	}
 }
+
+// A second answer to a call the input already answers is dropped, the
+// first standing, as pairToolMessages and pairToolBlocks leave it: OpenAI's
+// Responses API refuses the duplicate with 400 "Duplicate item found with
+// id fc_… Remove duplicate items from your input and try again" (a client
+// replaying a history that holds a call's approval and its output twice
+// sends both; the Chat and Messages builds mend the same shape).
+func TestPairToolItemsDropsASecondAnswer(t *testing.T) {
+	// the first answer stands, the second goes
+	in := inputOf(t, pairToolItems([]byte(`{"model":"m","input":[`+
+		`{"type":"function_call","call_id":"c1","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call_output","call_id":"c1","output":"first"},`+
+		`{"type":"function_call_output","call_id":"c1","output":"second"}]}`)))
+	if len(in) != 2 || in[1]["output"] != "first" {
+		t.Fatalf("the second answer stood: %v", in)
+	}
+
+	// three answers: one stands
+	in = inputOf(t, pairToolItems([]byte(`{"model":"m","input":[`+
+		`{"type":"custom_tool_call","call_id":"c1","name":"apply_patch","input":"x"},`+
+		`{"type":"custom_tool_call_output","call_id":"c1","output":"first"},`+
+		`{"type":"custom_tool_call_output","call_id":"c1","output":"second"},`+
+		`{"type":"custom_tool_call_output","call_id":"c1","output":"third"}]}`)))
+	if len(in) != 2 || in[1]["output"] != "first" {
+		t.Fatalf("the second and third custom answers stood: %v", in)
+	}
+
+	// a call two inputs answer, its answers apart, keeps the first
+	in = inputOf(t, pairToolItems([]byte(`{"model":"m","input":[`+
+		`{"type":"function_call","call_id":"c1","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call_output","call_id":"c1","output":"first"},`+
+		`{"type":"message","role":"user","content":[{"type":"input_text","text":"mid"}]},`+
+		`{"type":"function_call_output","call_id":"c1","output":"second"}]}`)))
+	if len(in) != 3 || in[1]["output"] != "first" {
+		t.Fatalf("the later answer stood: %v", in)
+	}
+
+	// answers of their own calls beside a duplicated one stay
+	in = inputOf(t, pairToolItems([]byte(`{"model":"m","input":[`+
+		`{"type":"function_call","call_id":"c1","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call","call_id":"c2","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call_output","call_id":"c2","output":"ok"},`+
+		`{"type":"function_call_output","call_id":"c2","output":"again"},`+
+		`{"type":"function_call_output","call_id":"c1","output":"ok"}]}`)))
+	if len(in) != 4 || in[2]["call_id"] != "c2" || in[3]["call_id"] != "c1" {
+		t.Fatalf("answers of their own calls were touched: %v", in)
+	}
+
+	// a lone call between answers of another call still gets its synthetic
+	// result, after the run's results
+	in = inputOf(t, pairToolItems([]byte(`{"model":"m","input":[`+
+		`{"type":"function_call","call_id":"c1","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call","call_id":"c2","name":"echo","arguments":"{}"},`+
+		`{"type":"function_call_output","call_id":"c2","output":"second"},`+
+		`{"type":"function_call_output","call_id":"c2","output":"second, again"}]}`)))
+	var order []string
+	for _, it := range in {
+		order = append(order, it["type"].(string)+":"+func() string { s, _ := it["call_id"].(string); return s }())
+	}
+	want := []string{"function_call:c1", "function_call:c2", "function_call_output:c2", "function_call_output:c1"}
+	if len(order) != len(want) {
+		t.Fatalf("items %v, want %v", order, want)
+	}
+	for i := range want {
+		if order[i] != want[i] {
+			t.Fatalf("items %v, want %v", order, want)
+		}
+	}
+}
+
+// The relay drops a duplicated answer through the whole gateway.
+func TestResponsesRelayDropsASecondAnswer(t *testing.T) {
+	f := &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`)}
+	setup(t, provider.Responses, f)
+	body := `{"model":"fake/m1","stream":true,"input":[` +
+		`{"type":"message","role":"user","content":[{"type":"input_text","text":"run it"}]},` +
+		`{"type":"function_call","call_id":"call_a","name":"echo","arguments":"{}"},` +
+		`{"type":"function_call_output","call_id":"call_a","output":"first result"},` +
+		`{"type":"function_call_output","call_id":"call_a","output":"second result"},` +
+		`{"type":"message","role":"user","content":[{"type":"input_text","text":"go on"}]}]}`
+	if code, out := post(t, "/v1/responses", body); code != 200 {
+		t.Fatalf("status %d: %s", code, out)
+	}
+	in := inputOf(t, f.got)
+	n := 0
+	for _, it := range in {
+		if it["type"] == "function_call_output" && it["call_id"] == "call_a" {
+			n++
+		}
+	}
+	if n != 1 {
+		t.Fatalf("%d answers for call_a reached the upstream: %s", n, f.got)
+	}
+}
diff --git a/internal/gateway/responses.go b/internal/gateway/responses.go
index 6bef499e..8e1a7e3e 100644
--- a/internal/gateway/responses.go
+++ b/internal/gateway/responses.go
@@ -723,9 +723,11 @@ func orphanedToolOutputs(body []byte) []byte {
 // messages responding to each 'tool_call_id'" (#1341), and OpenAI's own
 // Responses API "No tool output found for function call". The result goes
 // at the end of the run of calls and results the call is in, where a chat
-// form has its tool messages. A result with no call is left to
-// orphanedToolOutputs, and one naming a call another request carried
-// (previous_response_id) stays as it is.
+// form has its tool messages. A second answer to a call is dropped, the
+// first standing, as pairToolMessages and pairToolBlocks leave it —
+// OpenAI's own API refuses the duplicate item. A result with no call is
+// left to orphanedToolOutputs, and one naming a call another request
+// carried (previous_response_id) stays as it is.
 func pairToolItems(body []byte) []byte {
 	if !bytes.Contains(body, []byte(`_call"`)) {
 		return body
@@ -757,9 +759,26 @@ func pairToolItems(body []byte) []byte {
 	}
 	out := make([]json.RawMessage, 0, len(input)+1)
 	var synthetic []json.RawMessage // results owed by the run in progress
+	seen := map[string]bool{}       // calls an answer ahead in the input gave
+	changed := false
 	for i, raw := range input {
-		out = append(out, raw)
 		it := items[i]
+		// a second answer to a call one answered already is dropped: the
+		// first stands, as pairToolMessages and pairToolBlocks leave it.
+		// OpenAI's Responses API refuses the duplicate: 400 "Duplicate
+		// item found with id fc_… Remove duplicate items from your input
+		// and try again" — a client replaying a history that holds an
+		// approval's call and its output twice sends both (vercel/ai
+		// #13307), and the relay passed the refusal on.
+		dup := toolResultItem(it.Type) && it.CallID != "" && seen[it.CallID]
+		if dup {
+			changed = true
+		} else {
+			out = append(out, raw)
+			if toolResultItem(it.Type) && it.CallID != "" {
+				seen[it.CallID] = true
+			}
+		}
 		if (it.Type == "function_call" || it.Type == "custom_tool_call") && it.CallID != "" && !answered[it.CallID] {
 			kind := "function_call_output"
 			if it.Type == "custom_tool_call" {
@@ -773,9 +792,10 @@ func pairToolItems(body []byte) []byte {
 		if len(synthetic) > 0 && exchange(it.Type) && (i+1 == len(input) || !exchange(items[i+1].Type)) {
 			out = append(out, synthetic...)
 			synthetic = nil
+			changed = true
 		}
 	}
-	if len(out) == len(input) {
+	if !changed {
 		return body
 	}
 	q["input"], _ = marshalPlain(out)
-- 
2.50.1 (Apple Git-155)


```

</details>

作者身份请保留（ggbdpq <ggbdpq@gmail.com>）。若维护者认为「直通不改 body」优先级高于交换修补、宁可原样透传，也请直接说，我把分支撤掉——这个改动与 #1341 引入 relay 修补的取舍是同一个问题。

Generated-by: GLM-5.3-Flash (ZCode)
