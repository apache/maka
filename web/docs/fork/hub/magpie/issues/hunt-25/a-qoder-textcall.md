gateway: 一个读不出来的 `<tool_call>` 文本块被当作回答发给 agent，200 + stop，调用丢失也无法故障转移（plugins#132 的内置侧兄弟面）

## 现象

通过内置 Qoder/Qoder CN 订阅（未搬到 `@magpie-community/opencode-qoder-auth` 插件的账号）会话时，如果模型把工具调用写进文本而这块文本读不出来——比如 JSON 缺字段 `{"path":}`——magpie 把整个 `<tool_call>{"path":}</tool_call>` 当作 assistant 的回答文本原样发出，`finish_reason` 是 `stop`，HTTP 200。调用丢失，客户端和 magpie 都不认为失败，不会换下一个 key/账号重试。流在中途断在块内时同理，截断的半块也作为回答文本发出。

这和已合并进插件 0.2.16 的缺陷完全同形：plugins#132 修的就是这两个出口（"a `<tool_call>` block with bad JSON (`{\"path\":}`), or one the stream ended inside, went out as the reply text with finish \"stop\" and a 200"）。8fdd296d 把搬迁账号升到 0.2.16 时正文写明 "The built-in internal/gateway/qoder.go still has the same two exits for accounts that haven't moved. This commit doesn't change that."——内置侧至今没跟上，同一厂商的两类用户行为分叉：搬了的报错可重试，没搬的绿色 200 丢调用。

## 最小复现

假 Qoder 上游回一条 SSE，content delta 携带坏 JSON 块（真实尖括号）：

```
data: {"body":"{\"choices\":[{\"delta\":{\"content\":\"<tool_call>{\"path\":}</tool_call>\"}}],\"object\":\"chat.completion.chunk\"}","statusCodeValue":200}
data: {"body":"{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}","statusCodeValue":200}
```

`stream:false` 请求经内置 Qoder 通道：得到 200，`choices[0].message.content` 就是 `<tool_call>{"path":}</tool_call>` 原文，`finish_reason` `"stop"`。`stream:true` 同样 200，块作为 content delta 流给客户端后正常收尾。仓库内等价复现：`TestQoderUnreadableToolCall`（本 patch 新增），在 2e2c8903 上四个缺陷形状全红，其中两个用例的失败输出即上面的 200 + 原文 content。

## 根因

`internal/gateway/qoder.go`（2e2c8903）：

- `qoderText.feed`：完整块 `qoderParseCall` 失败时走 `out = append(out, qoderFrag{text: qoderCallOpen + comb[:j] + qoderCallClose})`（qoder.go:716）——读不出的块降级为文本。
- `qoderText.flush`：流在块内结束时 `t := qoderCallOpen + a.callBuf`（qoder.go:726）整块当文本发出，连 JSON 已完整、只差闭合标签的情况也不尝试解析。

## 修法

把插件 0.2.16 的判定原样 port 进内置拆分器（74341930）：

- `callish`（块以 `{` 开头或含 `<function=`）且不在代码围栏/行内代码里的不可读块 → 502 错误帧；正文已开始流出时 200 站住、错误帧后无 finish（`TestQoderEnvelopeErrors` 的 stream+partial 语义）。
- 流在块内结束：JSON 完整 → 仍算调用（`finish_reason` `tool_calls`，可故障转移）；否则 502。
- 完全不是调用的标记（如 `before <tool_call>incomplete`）和代码块里的示例（` ```text` 围栏内）保持文本——既有 `TestQoderEOF` 的 "incomplete" 用例在插件语义下不变，仍是绿的。
- 文本增量记入 `qoderText.sent` 供代码围栏判定；`qoderFrag` 增加 `err`，`decodeQoder` 三处 frag 消费点统一走新的 `emit`。

## 验证

| 检查 | 结果 |
| --- | --- |
| 修前红（2e2c8903，fetch 后 tip 即基线） | `TestQoderUnreadableToolCall` 4 个缺陷用例红：`status 200 want 502` + 失败输出含 `"<tool_call>{\"path\":}</tool_call>"` 的 content；流截断 JSON 完整用例红：调用变文本。2 个 stays-text 守护用例绿 |
| 修后绿 | 同测试 7 个用例全绿；`go test -tags nogui -p 2 -count=1 -run 'TestQoder\|TestTextWritten\|TestPluginTextWritten\|TestQuiet' ./internal/gateway/` ok |
| 消融回红（基线=修复提交父 2e2c8903，显式 `git checkout 2e2c8903 -- internal/gateway/qoder.go`） | 5 个缺陷用例重放红，守护用例仍绿；产品文件还原后全绿 |
| gofmt -l internal/ | 干净 |
| go vet（darwin, -tags nogui） | 除已知 `trayimage_darwin.go` cgo `-Wenum-conversion` 警告外干净 |
| GOOS=linux go vet -tags nogui / GOOS=windows go vet | 干净 |
| go build darwin / linux(-tags nogui) / windows | ok（darwin 只有本机 ld 版本噪音） |

## 没跑什么

- 全量 `go test ./...`（gateway 全包 ~40 分钟）：只跑了上面点名的 Qoder/textcalls/plugin-textcalls/quiet 定向集；改动只触及 internal/gateway 包内未导出符号，其他包无引用。
- 真实 Qoder / Qoder CN 账号（无有效凭据）：坏 JSON 块的字节形状取自 plugins#132 的实锤样例（`{"path":}`）。
- 搬迁侧（插件 0.2.16）行为未在本机复验，以其 npm 包与 plugins#132 描述为准。
- Windows 实机未测（无跨平台分支改动）。

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

fork 分支：https://github.com/ggbdpq/magpie/tree/hunt25-audit-qoder-textcall

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>patch</summary>

````
From 74341930653ac1b71ae9f9c43bb9af030cb60217 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:05:08 +0800
Subject: [PATCH] qoder: a tool call written into the text that can't be read
 ends the turn as an error, never as the answer
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed
A whole <tool_call> block whose JSON doesn't parse, or one the stream
ends inside, reached the agent as the reply text with finish "stop" and
a 200: the call was lost and nothing could fail over. The moved qoder
plugin's 0.2.16 ends such a turn as an error (plugins#132, as trae's
since plugins#38); 8fdd296d, which raised the mover's min, left the
built-in's two exits as they were. The built-in now ends the turn the
same way the plugin does: a block on its way to being a call (its JSON
began, or the XML function form) that can't be read is a 502 — an error
frame with no finish once text was streamed, the status alone before
anything was — and one the stream ends inside is the call when its JSON
is whole, else a 502. A marker that is no call at all, and a block
inside a code fence or inline span, stay text (TestQoderEOF's
"incomplete" case among them, unchanged). Splitter state is qoderText's
new sent (the text given out, so a block in code is told from a call)
and qoderFrag's err, lifted by decodeQoder's emit.

Run
- go test -tags nogui -p 2 -count=1 -run 'TestQoder|TestTextWritten|TestPluginTextWritten|TestQuiet' ./internal/gateway/: ok
  (new TestQoderUnreadableToolCall: the four defect shapes red on
  2e2c8903 — 200 with the block as content, and the cut-short whole-JSON
  call as text — green here; the two stays-text guards green on both)
- gofmt -l internal/: clean. go vet -tags nogui ./internal/gateway: clean.
- Full matrix and ablation recorded in the issue body.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/qoder.go      |  95 +++++++++++++++++++++++------
 internal/gateway/qoder_test.go | 108 +++++++++++++++++++++++++++++++++
 2 files changed, 185 insertions(+), 18 deletions(-)

diff --git a/internal/gateway/qoder.go b/internal/gateway/qoder.go
index 46a10b21f..cb73efa6b 100644
--- a/internal/gateway/qoder.go
+++ b/internal/gateway/qoder.go
@@ -562,9 +562,29 @@ func decodeQoder(ctx context.Context, res *http.Response, out chan<- Event, mode
 		return
 	}
 	a := qoderText{tool: -1}
+	// emit lifts one piece of the split text into events: a call, the text,
+	// or a call that can't be read, which ends the turn as an error so the
+	// agent can try it again (plugins#132, as the moved qoder plugin's).
+	// False when the turn ends here: the consumer went, or an error was
+	// sent — an error frame carries no finish.
+	emit := func(frag qoderFrag) bool {
+		switch {
+		case frag.err != "":
+			send(Event{Kind: KError, Status: 502, Text: frag.err})
+			return false
+		case frag.call != nil:
+			if !send(Event{Kind: KToolStart, ID: "call_" + qoder.NewID(), Name: frag.call.name}) {
+				return false
+			}
+			return send(Event{Kind: KToolArgs, Text: frag.call.args})
+		case frag.text != "":
+			return send(Event{Kind: KText, Text: frag.text})
+		}
+		return true
+	}
 	finish := func() {
 		for _, frag := range a.flush() {
-			if frag.text != "" && !send(Event{Kind: KText, Text: frag.text}) {
+			if !emit(frag) {
 				return
 			}
 		}
@@ -606,17 +626,7 @@ func decodeQoder(ctx context.Context, res *http.Response, out chan<- Event, mode
 		}
 		if content := delta.Get("content"); content.Exists() {
 			for _, frag := range a.feed(content.String()) {
-				ev := Event{}
-				if frag.call != nil {
-					ev = Event{Kind: KToolStart, ID: "call_" + qoder.NewID(), Name: frag.call.name}
-					if !send(ev) {
-						return
-					}
-					ev = Event{Kind: KToolArgs, Text: frag.call.args}
-				} else {
-					ev = Event{Kind: KText, Text: frag.text}
-				}
-				if !send(ev) {
+				if !emit(frag) {
 					return
 				}
 			}
@@ -628,7 +638,7 @@ func decodeQoder(ctx context.Context, res *http.Response, out chan<- Event, mode
 			if idx != a.tool {
 				a.tool = idx
 				for _, frag := range a.flush() {
-					if frag.text != "" && !send(Event{Kind: KText, Text: frag.text}) {
+					if !emit(frag) {
 						return
 					}
 				}
@@ -664,21 +674,49 @@ func decodeQoder(ctx context.Context, res *http.Response, out chan<- Event, mode
 }
 
 // qoderText is the streaming tool-call splitter: it holds text until a full
-// tool-call block arrives, then emits it as a call.
+// tool-call block arrives, then emits it as a call. A block on its way to
+// being a call that can't be read, or that the stream ends inside, is an
+// error, never the answer (plugins#132, as the moved qoder plugin's 0.2.16):
+// the turn fails, so it can be tried again. A block whose JSON is whole when
+// the stream ends without its close is still the call; one that is no call
+// at all, or one inside code, stays text.
 type qoderText struct {
 	textBuf string
 	callBuf string
 	inCall  bool
 	sawTool bool
-	tool    int // index of the native tool call being assembled, -1 for none
+	sent    string // the text given out so far, to tell a block in code from a call
+	tool    int    // index of the native tool call being assembled, -1 for none
 }
 
 type qoderFrag struct {
 	text string
 	call *qoderCall
+	err  string
 }
 type qoderCall struct{ name, args string }
 
+// qoderQuoted says text ends inside a code fence or an inline code span: a
+// tool-call block there is prose about one, not a call.
+func qoderQuoted(text string) bool {
+	if strings.Count(text, "```")%2 == 1 {
+		return true
+	}
+	line := text[strings.LastIndex(text, "\n")+1:]
+	return strings.Count(strings.ReplaceAll(line, "```", ""), "`")%2 == 1
+}
+
+// qoderCallish says a block was on its way to being a call: its JSON began,
+// or the XML function form.
+func qoderCallish(v string) bool {
+	return strings.HasPrefix(strings.TrimLeft(v, " \t\r\n"), "{") || strings.Contains(v, "\x3cfunction=")
+}
+
+const (
+	qoderCallUnreadable = "Qoder: the model's tool call, written as text, can't be read; it is not sent on as the answer"
+	qoderCallCutShort   = "Qoder: the model's tool call, written as text, was cut short; it is not sent on as the answer"
+)
+
 func (a *qoderText) feed(input string) []qoderFrag {
 	var out []qoderFrag
 	for input != "" {
@@ -688,6 +726,7 @@ func (a *qoderText) feed(input string) []qoderFrag {
 			i := strings.Index(comb, qoderCallOpen)
 			if i < 0 {
 				if keep := qoderSuffix(comb); keep < len(comb) {
+					a.text(comb[:len(comb)-keep])
 					out = append(out, qoderFrag{text: comb[:len(comb)-keep]})
 					a.textBuf = comb[len(comb)-keep:]
 				} else {
@@ -696,6 +735,7 @@ func (a *qoderText) feed(input string) []qoderFrag {
 				break
 			}
 			if i > 0 {
+				a.text(comb[:i])
 				out = append(out, qoderFrag{text: comb[:i]})
 			}
 			input = comb[i+len(qoderCallOpen):]
@@ -709,11 +749,16 @@ func (a *qoderText) feed(input string) []qoderFrag {
 			a.callBuf = comb
 			break
 		}
-		if c, ok := qoderParseCall(comb[:j]); ok {
+		body := comb[:j]
+		if c, ok := qoderParseCall(body); ok {
 			a.sawTool = true
 			out = append(out, qoderFrag{call: &c})
+		} else if qoderCallish(body) && !qoderQuoted(a.sent) {
+			a.inCall = false
+			return append(out, qoderFrag{err: qoderCallUnreadable})
 		} else {
-			out = append(out, qoderFrag{text: qoderCallOpen + comb[:j] + qoderCallClose})
+			a.text(qoderCallOpen + body + qoderCallClose)
+			out = append(out, qoderFrag{text: qoderCallOpen + body + qoderCallClose})
 		}
 		input = comb[j+len(qoderCallClose):]
 		a.inCall = false
@@ -721,10 +766,23 @@ func (a *qoderText) feed(input string) []qoderFrag {
 	return out
 }
 
+// text hands a piece of text out, remembering it: whether the next block is
+// inside code is told from what came before it.
+func (a *qoderText) text(t string) { a.sent += t }
+
 func (a *qoderText) flush() []qoderFrag {
 	if a.inCall {
-		t := qoderCallOpen + a.callBuf
+		body := a.callBuf
 		a.inCall, a.callBuf = false, ""
+		if qoderCallish(body) && !qoderQuoted(a.sent) {
+			if c, ok := qoderParseCall(body); ok {
+				a.sawTool = true
+				return []qoderFrag{{call: &c}}
+			}
+			return []qoderFrag{{err: qoderCallCutShort}}
+		}
+		t := qoderCallOpen + body
+		a.text(t)
 		if t != "" {
 			return []qoderFrag{{text: t}}
 		}
@@ -732,6 +790,7 @@ func (a *qoderText) flush() []qoderFrag {
 	if a.textBuf != "" {
 		t := a.textBuf
 		a.textBuf = ""
+		a.text(t)
 		return []qoderFrag{{text: t}}
 	}
 	return nil
diff --git a/internal/gateway/qoder_test.go b/internal/gateway/qoder_test.go
index 35c6e361c..6bff9049b 100644
--- a/internal/gateway/qoder_test.go
+++ b/internal/gateway/qoder_test.go
@@ -263,6 +263,114 @@ func TestQoderEOF(t *testing.T) {
 	}
 }
 
+// A tool call written into the text that can't be read ends the turn as an
+// error, never as the answer (plugins#132, as the moved qoder plugin's
+// 0.2.16): a whole block whose JSON doesn't parse is a 502, and one the
+// stream ends inside is the call when its JSON is whole, else a 502. A
+// marker that is no call at all, or a block inside code, stays text.
+func TestQoderUnreadableToolCall(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	bad := qoderCallOpen + `{"path":}` + qoderCallClose
+	cutWhole := qoderCallOpen + `{"name":"read","arguments":{"path":"x"}}`
+	for _, tt := range []struct {
+		name    string
+		lines   []string
+		stream  bool
+		want    int
+		noText  string // never in the reply
+		text    string // the whole reply's text, when text is wanted
+		frame   string // in the reply as it came, when a frame is wanted
+		hasCall string // a tool call named so, when one is wanted
+	}{
+		{
+			name:   "unreadable block, whole reply",
+			lines:  []string{qoderChunk(qoderContent(t, bad)), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: false,
+			want:   502,
+			noText: "tool_call>",
+		},
+		{
+			name:   "unreadable block, streamed",
+			lines:  []string{qoderChunk(qoderContent(t, bad)), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: true,
+			want:   502,
+			noText: "tool_call>",
+		},
+		{
+			// text was already going out, so the 200 stands: the reason is
+			// an error frame, and no finish follows it
+			name:   "unreadable block after text, streamed",
+			lines:  []string{qoderChunk(qoderContent(t, "Sure. ")), qoderChunk(qoderContent(t, bad)), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: true,
+			want:   200,
+			noText: `"finish_reason":"stop"`,
+			frame:  "can't be read",
+		},
+		{
+			name:    "stream ends inside, JSON whole",
+			lines:   []string{qoderChunk(qoderContent(t, cutWhole)), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream:  false,
+			want:    200,
+			noText:  "tool_call>",
+			hasCall: "read",
+		},
+		{
+			name:   "stream ends inside, unreadable",
+			lines:  []string{qoderChunk(qoderContent(t, qoderCallOpen+`{"path":`)), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: false,
+			want:   502,
+			noText: "tool_call>",
+		},
+		{
+			name:   "a marker that is no call stays text",
+			lines:  []string{qoderChunk(qoderContent(t, "before "+qoderCallOpen+"incomplete")), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: false,
+			want:   200,
+			text:   "before " + qoderCallOpen + "incomplete",
+		},
+		{
+			name:   "a block inside code stays text",
+			lines:  []string{qoderChunk(qoderContent(t, "```text\n"+bad+"\n```")), qoderChunk(`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)},
+			stream: false,
+			want:   200,
+			text:   bad,
+		},
+	} {
+		t.Run(tt.name, func(t *testing.T) {
+			done := qoderUpstream(t, tt.lines)
+			defer done()
+			s := New()
+			w := httptest.NewRecorder()
+			body := `{"model":"qfmodel","stream":` + map[bool]string{true: "true", false: "false"}[tt.stream] + `,"messages":[{"role":"user","content":"hi"}]}`
+			r := httptest.NewRequest("POST", "/", strings.NewReader(body))
+			var u Usage
+			status, msg := s.serveQoder(w, r, provider.Chat, provider.Provider{Account: &provider.Account{User: "test"}}, "qfmodel", []byte(body), &u)
+			out := w.Body.String()
+			if status != tt.want {
+				t.Fatalf("status %d msg %q want %d\n%s", status, msg, tt.want, out)
+			}
+			if tt.noText != "" && strings.Contains(out, tt.noText) {
+				t.Fatalf("the unreadable block went out as the answer:\n%s", out)
+			}
+			if tt.text != "" && !strings.Contains(gjson.Get(out, "choices.0.message.content").String(), tt.text) {
+				t.Fatalf("text was changed to %q:\n%s", gjson.Get(out, "choices.0.message.content").String(), out)
+			}
+			if tt.frame != "" && !strings.Contains(out, tt.frame) {
+				t.Fatalf("the reply doesn't carry the reason:\n%s", out)
+			}
+			if tt.hasCall != "" {
+				if gjson.Get(out, "choices.0.message.tool_calls.0.function.name").String() != tt.hasCall {
+					t.Fatalf("the whole-JSON call cut short is not a call:\n%s", out)
+				}
+				if gjson.Get(out, "choices.0.finish_reason").String() != "tool_calls" {
+					t.Fatalf("finish %q, want tool_calls:\n%s", gjson.Get(out, "choices.0.finish_reason").String(), out)
+				}
+			}
+		})
+	}
+}
+
 func TestQoderEnvelopeErrors(t *testing.T) {
 	for _, status := range []int{401, 403, 429, 500} {
 		for _, proto := range []provider.Protocol{provider.Chat, provider.Responses, provider.Anthropic, provider.Gemini} {
-- 
2.50.1 (Apple Git-155)
````

</details>
