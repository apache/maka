The tool-calling mode a Zed Gemini request goes out with is now the one Zed's cloud parses: lowercase, on the tool-bearing turns that were all 400ing.

**What happens**

Every tool-bearing request to a Gemini model of the Zed plugin (`@magpie-community/opencode-zed-auth`) came back Zed's 400 "failed to parse Google AI request: unknown variant `AUTO`, expected one of `auto`, `any`, `none`" — tool-less ones and the same payload on the plugin's Claude and GPT models went through, so every real agent turn (they all declare tools) was refused while plain chat and `magpie provider test` looked healthy.

**Why**

The plugin's Gemini models go out on Code Assist's wire (`pluginProtocol` keys `@ai-sdk/google` to Code Assist), and the envelope's only writer of the field (`buildCodeAssistSent`, `internal/gateway/codeassist.go`) hard-codes Google's proto enums `AUTO`/`ANY` — right for Google's own Code Assist accounts (Gemini CLI, Antigravity, Vertex), whose APIs take those enums, but Zed's cloud reads the field with lowercase variants only. The zed account's body fitter (`ZedBody`, installed at the plugin wiring for `pp.ID == "zed"`) passed the envelope through untouched: it fits Responses bodies and returns anything without an `input` list as it came, so the uppercase mode survived to `pluginFetch`'s unwrap and on to Zed.

**What changed**

`ZedCodeAssist` (`internal/provider/zed_body.go`) fits the envelope too: the mode inside `request.toolConfig.functionCallingConfig` goes out lowercased (gjson to locate, a byte splice to rewrite, nothing else in the body moves). It is wired beside `ZedBody` on the zed account's fitter alone — Google's own accounts keep `AUTO`/`ANY`, `VALIDATED` is Antigravity's alone and never reaches a plugin, and no other plugin's wire changes. The read side was already case-tolerant, and no sibling needed the same edit; each of these was checked and left alone: `ZedBody`'s own guard (envelopes have no `input`), the Gemini request parser and `requiredAllowlist` (both `EqualFold`/`ToUpper`), the search paths (gated by `googleAccount`, which excludes plugins), and the other plugins (none but zed is keyed on this fix; a future `@ai-sdk/google` plugin keeps whatever its vendor reads).

**Verification**

| Check | Result |
|---|---|
| `TestZedPluginGoogleAIToolModeLowercase` (new; a tools-bearing chat request through the fake zed plugin to an upstream that parses like Zed's Google-AI request type) | fails on `647323409` with that exact 400, passes with the change |
| Ablation: only the two product files reverted to the parent commit, test kept | red again with the same 400 |
| `-run Zed` in `internal/gateway` and `internal/provider` | ok |
| Full `go test -tags nogui` of the two changed packages | ok (gateway 529.7s, provider 97.1s) |
| The targeted Zed tests with `-race` | ok |
| `gofmt -l` on the three changed files | no output |
| `go vet` on the two packages, darwin / `GOOS=linux -tags nogui` / `GOOS=windows` | clean |
| `go build -tags nogui ./...` darwin / linux / `GOOS=windows go build ./...` | ok (darwin logs pre-existing cgo enum-conversion warnings in `internal/gui`, untouched here) |

**Not verified**

- No request was made to `cloud.zed.dev`: the upstream in the test is a fake that parses like Zed's Google-AI request type; live confirmation needs a Zed account, which atticuskk kindly offered.
- Only the two changed packages were run this round, not every package of the repo; no failures appeared in either of them.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Zed plugin Gemini request carries the tool-calling mode Zed's cloud reads (#4657) — git am applies it as is; SHA-256 first 16: 85dd6120ed81daf2</summary>

```patch
From b9921ff352e3b403cf130b57fe9d39b982f25e47 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 16:02:57 +0800
Subject: [PATCH] gateway: a Zed plugin Gemini request carries the tool-calling
 mode Zed's cloud reads

What changed: a tool-bearing request to a Gemini model of the Zed
plugin (@magpie-community/opencode-zed-auth) went out on Code Assist's
wire with toolConfig.functionCallingConfig.mode in Google's proto
enums (AUTO, ANY), and Zed's cloud reads that field with lowercase
variants only - every such turn came back 400 "failed to parse Google
AI request: unknown variant `AUTO`, expected one of `auto`, `any`,
`none`", while tool-less ones and the same payload on the plugin's
Claude and OpenAI models went through (#4657). The zed account's body
fitter now fits a Code Assist envelope too (ZedCodeAssist): the mode
goes out lowercase, keyed on the zed plugin alone - Google's own Code
Assist accounts (Gemini CLI, Antigravity, Vertex) keep the proto enums
their APIs take, and VALIDATED is Antigravity's alone, so it never
reaches a plugin.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/plugin_zed_test.go | 62 +++++++++++++++++++++++++++++
 internal/provider/plugins.go        |  6 ++-
 internal/provider/zed_body.go       | 29 ++++++++++++++
 3 files changed, 95 insertions(+), 2 deletions(-)

diff --git a/internal/gateway/plugin_zed_test.go b/internal/gateway/plugin_zed_test.go
index 56312ba35..bad38dced 100644
--- a/internal/gateway/plugin_zed_test.go
+++ b/internal/gateway/plugin_zed_test.go
@@ -137,3 +137,65 @@ func TestZedPluginGetsNoDeveloperRole(t *testing.T) {
 		t.Fatalf("Zed was offered %s", got)
 	}
 }
+
+// zedParsesGoogleAI is what Zed's cloud asks of a Google AI request, the
+// one its Gemini models are asked on: the tool-calling mode in lowercase
+// (auto, any, none), "" when it would take it.
+func zedParsesGoogleAI(q map[string]any) string {
+	tc, _ := q["toolConfig"].(map[string]any)
+	fc, _ := tc["functionCallingConfig"].(map[string]any)
+	mode, _ := fc["mode"].(string)
+	switch mode {
+	case "", "auto", "any", "none":
+		return ""
+	}
+	return "unknown variant `" + mode + "`, expected one of `auto`, `any`, `none`"
+}
+
+// A tool-bearing request to a Gemini model of Zed's plugin goes out on
+// Code Assist's wire with the tool-calling mode in the case Zed's cloud
+// reads: lowercase (auto, any, none), where Google's own APIs take the
+// proto enums AUTO, ANY — every such turn came back "failed to parse
+// Google AI request: unknown variant `AUTO`" while tool-less ones went
+// through (atticuskk, #4657).
+func TestZedPluginGoogleAIToolModeLowercase(t *testing.T) {
+	var mu sync.Mutex
+	var sent []map[string]any
+	pid := besideFake(t, "zed", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		var q map[string]any
+		json.Unmarshal(b, &q)
+		mu.Lock()
+		sent = append(sent, q)
+		mu.Unlock()
+		if why := zedParsesGoogleAI(q); why != "" {
+			w.Header().Set("Content-Type", "application/json")
+			w.WriteHeader(400)
+			io.WriteString(w, `{"error":{"message":"Zed: failed to parse Google AI request: `+why+`"}}`)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]}}],"modelVersion":"gm"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}`,
+		))
+	}))
+	body := `{"model":"` + pid + `/fake-gemini","max_tokens":40,"messages":[
+		{"role":"user","content":"Weather in Paris? Use the tool."}],
+		"tools":[{"type":"function","function":{"name":"get_weather","description":"Get weather",
+		"parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}`
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body)))
+	if rec.Code != 200 {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 1 {
+		t.Fatalf("asked %d times", len(sent))
+	}
+	fc := sent[0]["toolConfig"].(map[string]any)["functionCallingConfig"].(map[string]any)
+	if mode := fc["mode"].(string); mode != "auto" {
+		t.Fatalf("Zed's cloud was handed toolConfig mode %q; it reads lowercase (auto, any, none)", mode)
+	}
+}
diff --git a/internal/provider/plugins.go b/internal/provider/plugins.go
index df6ebad63..434faf617 100644
--- a/internal/provider/plugins.go
+++ b/internal/provider/plugins.go
@@ -489,8 +489,10 @@ func pluginProviderServing(pp plugin.Provider, l pluginLogin, keys []string) Pro
 	}
 	if pp.ID == "zed" {
 		// an OpenAI model's request as Zed's cloud reads it: Codex's
-		// developer messages as system ones, its namespaced tools flat
-		a.body = ZedBody
+		// developer messages as system ones, its namespaced tools flat;
+		// a Code Assist envelope's tool-calling mode in the case its
+		// Google-AI request type reads (ZedCodeAssist, #4657)
+		a.body = func(b []byte) []byte { return ZedBody(ZedCodeAssist(b)) }
 	}
 	a.models = func() []catalog.Model {
 		if cur, ok := PluginOf(id); ok {
diff --git a/internal/provider/zed_body.go b/internal/provider/zed_body.go
index 48a6e945c..bf48f11a3 100644
--- a/internal/provider/zed_body.go
+++ b/internal/provider/zed_body.go
@@ -12,6 +12,9 @@ package provider
 import (
 	"bytes"
 	"encoding/json"
+	"strings"
+
+	"github.com/tidwall/gjson"
 )
 
 // Zed's cloud reads an OpenAI model's request into its own Responses types
@@ -168,3 +171,29 @@ func ZedBody(body []byte) []byte {
 	}
 	return bytes.TrimRight(b.Bytes(), "\n")
 }
+
+// ZedCodeAssist is a Code Assist envelope fitted to Zed's cloud: its
+// Google-AI request type reads the tool-calling mode in lowercase (auto,
+// any, none), where Google's own APIs take the proto enums AUTO, ANY —
+// every tool-bearing request to a Zed Gemini model came back 400 "failed
+// to parse Google AI request: unknown variant `AUTO`" (#4657). VALIDATED
+// is Antigravity's alone and never goes to a plugin; a request with no
+// toolConfig, or a lowercase mode already, goes as it came.
+func ZedCodeAssist(body []byte) []byte {
+	if !bytes.Contains(body, []byte(`"toolConfig"`)) {
+		return body
+	}
+	v := gjson.GetBytes(body, "request.toolConfig.functionCallingConfig.mode")
+	if v.Type != gjson.String || v.Index <= 0 || !gjson.ValidBytes(body) {
+		return body
+	}
+	lower := strings.ToLower(v.Str)
+	if lower == v.Str {
+		return body
+	}
+	mode, _ := json.Marshal(lower)
+	out := make([]byte, 0, len(body)+len(mode))
+	out = append(out, body[:v.Index]...)
+	out = append(out, mode...)
+	return append(out, body[v.Index+len(v.Raw):]...)
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt115-d-4657](https://github.com/ggbdpq/magpie/tree/hunt115-d-4657) (head `b9921ff352e3b403cf130b57fe9d39b982f25e47`).
