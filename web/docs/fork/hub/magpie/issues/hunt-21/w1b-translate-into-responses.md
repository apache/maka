# gateway: Chat/Messages 客户端中断的 tool call 被原样翻进 Responses，上游 400 "No tool output found" 之后每轮都挂

分支 `hunt21-w1-translate-mend`（head `c8a3d435`，基于 upstream/main `743fcc035`（今日 tip；gateway 目录与我分支基点 `a36319d6` 零 diff，已核对））。发帖前已再 fetch upstream。

## 现象

Chat 或 Anthropic 客户端的会话里，一个 tool call 没有结果就带着历史进了下一轮——turn 被中断后重试的最普通形状（用户 ESC、断网、客户端崩溃恢复）。这个会话打到 Responses 协议的上游时，`buildResponses` 把它原样翻成一个没有 `function_call_output` 跟随的 `function_call`。OpenAI Responses API 对它回 400：

> No tool output found for function call call_a.

而那个中断的 call 在客户端历史里一直在，之后**每一轮**都被上游拒，会话卡死，直到客户端自己丢历史。

通往 Responses 上游一共三条路，另外三条「修交换」的边界都在：Responses relay 补 synthetic（`pairToolItems`，#1341）；Chat 上游 `pairToolMessages`（#554、#1275）；Messages 上游 `pairToolBlocks`。唯独两条「翻译进 Responses」的路（Chat 客户端、Messages 客户端 → Responses 上游）没有交换修补——`forwardTranslated` 里 `buildFor` 的产物直接发送。

## 最小复现

新增 `internal/gateway/pair_tool_items_test.go` 的 `TestTranslatedToResponsesAnswersALoneCall`：Chat 客户端和 Anthropic 客户端各发一个带无回答 call 的会话到 Responses 上游，断言上游收到的 input 里有 synthetic `function_call_output`。修前（仅还原 `internal/gateway/gateway.go`）：

```text
--- FAIL: TestTranslatedToResponsesAnswersALoneCall (0.37s)
    pair_tool_items_test.go:229: a Chat client's lone call went unanswered into Responses:
      {"input":[{"content":[{"text":"run it","type":"input_text"}],"role":"user","type":"message"},
                {"arguments":"{}","call_id":"call_a","name":"echo","type":"function_call"},
                {"content":[{"text":"go on","type":"input_text"}],"role":"user","type":"message"}],
       "model":"m1","store":false,"stream":true}
```

`function_call` 后面直接跟着 user 消息，无回答。Messages 客户端的同形状同样红。

## 根因

`internal/gateway/gateway.go` 的 `forwardTranslated`：`body, err := buildFor(p, to, sent, model)` 之后，Chat 有 `asCompletionTokens` 等 destination 修补，Responses 没有任何交换修补。`buildResponses` 本身从 IR 重建 input，也不看交换是否成对。

## 修法

`forwardTranslated` 里 `to == provider.Responses` 时让 body 过一遍 `pairToolItems`——与 relay 面用同一个函数，语义完全一致（无回答的 call 在 run 末尾补 synthetic；前一条 commit 起重复回答也被丢弃）。

不扩 scope 的部分，及理由：

- **不挂 `joinToolRuns`**：它修的是 relay 客户端（Codex）在批次中间写 item 的乱序（#1752、#2100）；翻译的 input 是 magpie 从 IR 按序重建的，没有这个形状。
- **不挂 `orphanedToolOutputs`**：Chat 的 tool 消息缺 `tool_call_id` 会被翻成 `call_id: ""` 的 output，这个形状上游会不会拒我没有证据，先不动。
- **不动 Zed**：`zed.go` 的 body 自带 `ZedBody` 修补，不走这条挂点。
- 设计页不改：`docs/subsystems/gateway-routing.md` 对 relay 修补（#1341）的描述是行为性的，翻译面收敛到同一行为。

## 验证

| 命令 | 结果 |
| --- | --- |
| 修前（stash `gateway.go`）跑 `TestTranslatedToResponsesAnswersALoneCall` | FAIL，输出如上 |
| 修后同测试 + `TestTranslatedToResponsesKeepsAPairedExchange`（成对交换逐字节保持） | PASS |
| `go test -tags nogui -p 2 -count=1 -run 'TestPairToolItems\|TestResponsesRelay\|TestJoinToolRuns\|TestOrphanedToolOutputs' ./internal/gateway/` | ok |
| `go test -tags nogui -p 2 -count=1 ./internal/gateway/`（沙盒 HOME，全包） | ok（见文末说明） |
| `gofmt -l internal/` | 无输出 |
| `go vet -tags nogui ./internal/gateway` | 通过 |
| 三平台 build | OK（darwin 仅已知警告） |

## 没跑什么

- **没有真实 OpenAI 凭据**：`No tool output found for function call` 这句引文来自 responses.go:724 维护者自己写下的注释（#1341 的报告中 OpenAI 同款拒绝），未在本机对着 api.openai.com 复现 400。
- 除 OpenAI 外哪些 Responses 上游严格校验交换未逐一实测（OpenCode Zen 在 responses.go:511 记录过同型拒绝 "No tool output found for tool call"；火山 coding plan 是 #1341 的 relay 面，翻译面未测）。
- 「Responses-only 上游 + Chat/Messages 客户端」的组合在真实用户中的占比没有数据，只确认了 magpie 的 provider 配置允许这个组合（Responses 字段单独填）。
- 未跑 `-race`、GUI 与其他包的全量。

patch（`git format-patch -1 --stdout`，即下一条 commit `c8a3d435`）：

<details><summary>c8a3d435 gateway: a Chat or Messages client's broken tool exchange is mended on the way into Responses…</summary>

```patch
From c8a3d4358c30e0adb3a8efe1378c5a4445f38da0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 14 Oct 2026 23:42:08 +0800
Subject: [PATCH] gateway: a Chat or Messages client's broken tool exchange is
 mended on the way into Responses, as it is into Chat and Messages
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

forwardTranslated built the Responses body and sent it: a conversation
holding a call no result answers (a turn the client interrupted) went to
the upstream as a lone function_call, and one that checks the exchange
answers 400 "No tool output found for function call <id>" — every turn
after it too, until the client drops the call from its history. The Chat
build mends this (pairToolMessages, #554, #1275), the Messages build does
(pairToolBlocks), and the Responses relay mends its own (#1341); the two
translations into Responses were the boundary left open.

Now a body built for Responses goes through pairToolItems like a relayed
one: a call nothing answers gets its synthetic result at the run's end,
and (since the previous commit) a duplicated answer is dropped. A paired
exchange is built as it was (TestTranslatedToResponsesKeepsAPairedExchange:
the client's answer reaches the upstream byte for byte).

Not changed: buildResponses itself, joinToolRuns and orphanedToolOutputs
(a relay's client writes items between results; a translation's input
comes from the IR in order), and the Zed body, which fits itself
(ZedBody).

Run: go test -tags nogui -p 2 -count=1 ./internal/gateway; see the follow
comment for the whole matrix. TestTranslatedToResponsesAnswersALoneCall
fails without the gateway.go change (a Chat client's lone call goes
unanswered into Responses).

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go              | 10 ++++
 internal/gateway/pair_tool_items_test.go | 76 ++++++++++++++++++++++++
 2 files changed, 86 insertions(+)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index e32c3bd2..ede9e3e9 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4512,6 +4512,16 @@ func (s *Server) forwardTranslated(ctx context.Context, p provider.Provider, to
 		if err != nil {
 			return nil, to, err
 		}
+		if to == provider.Responses {
+			// an exchange a client left broken is mended on the way into
+			// Responses as it is into Chat (pairToolMessages, #554) and
+			// Messages (pairToolBlocks) and as the Responses relay mends
+			// its own (#1341): an upstream that checks the exchange (the
+			// OpenAI Responses API among them) refuses a call no result
+			// answers, and one answered twice, and the refusals went back
+			// to the client as they came
+			body = pairToolItems(body)
+		}
 		noteWireEffort(ctx, to, sent)
 		if to == provider.Chat && (p.IsBedrock() || p.IsAzure()) {
 			body = asCompletionTokens(body)
diff --git a/internal/gateway/pair_tool_items_test.go b/internal/gateway/pair_tool_items_test.go
index ae7bbede..b57a77d7 100644
--- a/internal/gateway/pair_tool_items_test.go
+++ b/internal/gateway/pair_tool_items_test.go
@@ -202,3 +202,79 @@ func TestResponsesRelayDropsASecondAnswer(t *testing.T) {
 		t.Fatalf("%d answers for call_a reached the upstream: %s", n, f.got)
 	}
 }
+
+// A client left with a call no result answers is mended on the way into
+// Responses as it is into Chat and Messages, and as the Responses relay
+// mends its own: the OpenAI Responses API refuses the lone call with 400
+// "No tool output found for function call <id>", and the refusal went back
+// to a Chat or Messages client as it came.
+func TestTranslatedToResponsesAnswersALoneCall(t *testing.T) {
+	f := &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`)}
+	setup(t, provider.Responses, f)
+	chat := `{"model":"fake/m1","stream":true,"messages":[` +
+		`{"role":"user","content":"run it"},` +
+		`{"role":"assistant","tool_calls":[{"id":"call_a","type":"function","function":{"name":"echo","arguments":"{}"}}]},` +
+		`{"role":"user","content":"go on"}]}`
+	if code, out := post(t, "/v1/chat/completions", chat); code != 200 {
+		t.Fatalf("status %d: %s", code, out)
+	}
+	in := inputOf(t, f.got)
+	answered := false
+	for _, it := range in {
+		if it["type"] == "function_call_output" && it["call_id"] == "call_a" {
+			answered = true
+		}
+	}
+	if !answered {
+		t.Fatalf("a Chat client's lone call went unanswered into Responses: %s", f.got)
+	}
+
+	f = &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`)}
+	setup(t, provider.Responses, f)
+	messages := `{"model":"fake/m1","stream":true,"max_tokens":16,"messages":[` +
+		`{"role":"user","content":"run it"},` +
+		`{"role":"assistant","content":[{"type":"tool_use","id":"call_a","name":"echo","input":{}}]},` +
+		`{"role":"user","content":"go on"}]}`
+	if code, out := post(t, "/v1/messages", messages); code != 200 {
+		t.Fatalf("status %d: %s", code, out)
+	}
+	in = inputOf(t, f.got)
+	answered = false
+	for _, it := range in {
+		if it["type"] == "function_call_output" && it["call_id"] == "call_a" {
+			answered = true
+		}
+	}
+	if !answered {
+		t.Fatalf("a Messages client's lone call went unanswered into Responses: %s", f.got)
+	}
+}
+
+// A well-formed exchange a Chat client sent goes into Responses as it was
+// built: no second answer of its own and no synthetic one beside a call
+// the input answers.
+func TestTranslatedToResponsesKeepsAPairedExchange(t *testing.T) {
+	f := &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}`)}
+	setup(t, provider.Responses, f)
+	chat := `{"model":"fake/m1","stream":true,"messages":[` +
+		`{"role":"user","content":"run it"},` +
+		`{"role":"assistant","tool_calls":[{"id":"call_a","type":"function","function":{"name":"echo","arguments":"{}"}}]},` +
+		`{"role":"tool","tool_call_id":"call_a","content":"ok"},` +
+		`{"role":"user","content":"go on"}]}`
+	if code, out := post(t, "/v1/chat/completions", chat); code != 200 {
+		t.Fatalf("status %d: %s", code, out)
+	}
+	in := inputOf(t, f.got)
+	outputs := 0
+	for _, it := range in {
+		if it["type"] == "function_call_output" {
+			outputs++
+			if it["call_id"] != "call_a" || it["output"] != "ok" {
+				t.Fatalf("the client's answer was changed: %v", it)
+			}
+		}
+	}
+	if outputs != 1 {
+		t.Fatalf("%d outputs for a paired exchange: %s", outputs, f.got)
+	}
+}
-- 
2.50.1 (Apple Git-155)


```

</details>

作者身份请保留（ggbdpq <ggbdpq@gmail.com>）。

Generated-by: GLM-5.3-Flash (ZCode)
