The two wires Codex's turns to Copilot take both refused a turn whose whole content was "hi", each on its own grounds.

**What happens**

Every tool-bearing turn to the Gemini models came back 400 "Copilot: invalid request body" (13 recorded failures across 5 sessions), and Grok 4.7 came back "Copilot: 422 Unprocessable Entity: Unprocessable Entity", six gateway requests of one turn in a row — while a tool-less provider test to the same Gemini came back 200. A Copilot Gemini model is served on chat completions alone, so Codex's Responses turn is translated for it; Grok is served on /responses, so the turn goes upstream as Codex sent it.

**Why**

- **Gemini**: what Copilot's Gemini rejects is the tool schemas' `anyOf` of object branches — #3931's comparisons showed it directly: the same request with the disjoint unions as `oneOf` came back 200, and nothing else about the tools (descriptions, strict, required) made the difference. The translation hands Codex's schemas through as they came, so `create_thread`'s disjoint target unions turned every tool-bearing turn away.
- **Grok**: `apply_patch` goes out as a custom tool on the Responses wire, and xAI behind Copilot takes none of those (#3392) — but Copilot's answer in front of Grok says no more than the status (#378's bare 400 is the same bluntness), so nothing in that 422 tells magpie's refusal-learner what to learn, the way DeepSeek's "Unsupported custom tool: 'exec'" does (#2656). Every turn failed the same way, and no provider switch happened to rescue it.

**What changed**

- `copilotGeminiToolUnions` (`internal/gateway/copilot_gemini_schema.go`): a tool schema's `anyOf` goes to Copilot's Gemini as `oneOf` when every two of its object branches are provably apart — both require a string field whose enum or const values never meet, or one requires a field the other forbids through `additionalProperties: false` (no `patternProperties` to admit it). The key is renamed in place, the same length, so nothing else of the body moves and a cache keeps its prefix. A union that can't be proved — nullable ones among them — stays an `anyOf`; Copilot's other models and every other provider are untouched.
- `customOff` (`internal/gateway/gateway.go`): a Codex turn with a custom tool to a Grok model on Copilot is translated from the first ask, as a learned refusal does elsewhere — the custom tools are offered as functions, and a call to one comes back as the `custom_tool_call` Codex runs. A model Copilot serves on the same /responses that takes custom tools (GPT) is relayed as it came.

**Verification**

| Check | Result |
|---|---|
| `TestCopilotGeminiTakesCodexUnionsAsOneOf` (new; a fake Copilot refusing a tool schema with an anyOf, word for word as this issue's Gemini record) | FAIL before (400 "invalid request body" verbatim), PASS after (200; the union goes out as `oneOf`) |
| `TestCopilotGrokTakesCustomToolsAsFunctions` (new; a fake Copilot whose Grok refuses a custom tool with #2951's bare 422, a GPT on the same /responses taking it as it came) | FAIL before (422 verbatim), PASS after (200; `apply_patch` as a function for Grok, custom kept for GPT) |
| `TestCopilotGeminiKeepsUnprovenUnions` (new; a union no one can prove) | PASS before and after: it stays an `anyOf` and the refusal still reaches the client |
| Ablation: only the schema fit removed, tests kept | the Gemini red comes back, the 400 verbatim; Grok stays green |
| Ablation: `gateway.go` back to the parent commit, tests kept | both reds come back, the 400 and the 422 verbatim |
| Copilot and custom-tool tests already in the tree (`TestCopilot*`, `TestCustomTool*`, `TestCodexCustomTool*`) | PASS |
| The three new tests under `-race` | PASS |
| `go test -tags nogui ./internal/gateway` (whole package) | ok (527.7s) |
| `gofmt -l` on the three changed files | no output |
| `go vet -tags nogui` on the package, darwin / `GOOS=linux` / `GOOS=windows` | clean |
| `go build -tags nogui ./...` darwin / linux / windows | ok (darwin logs the pre-existing cgo enum-conversion warnings in internal/gui, untouched here) |

**Not verified**

- No request was made to a real Copilot account: the upstream in the tests is a fake that refuses with the exact bodies the reporters recorded. For Gemini the refusal is pinned by #3931's live comparisons, and this issue asked for exactly that path to be checked. For Grok the trigger is read from two earlier records together — xAI takes no custom tool (#3392), Copilot's answer in front of Grok carries no detail (#378) — so if grok-4.7's 422 is over something else of Codex's turn (a hosted tool, say), the translation won't have fixed it; the Request Archive's captured upstream body would say which field it was.
- The whole-repository suite was not run this session — the changed package plus the targeted runs only.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): Copilot's Gemini takes Codex's disjoint unions as oneOf, its Grok the custom tools as functions (#4374) — git am applies it as is; SHA-256 first 16: 35158dcf857a45ea</summary>

```patch
From ced7c173f29f00292a1d817e320cea110c2bb1f5 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 21:34:56 +0800
Subject: [PATCH] fix(gateway): Copilot's Gemini takes Codex's disjoint unions
 as oneOf, its Grok the custom tools as functions (#4374)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: Codex Desktop through Copilot failed on every tool-bearing
turn, on two wires at once (#4374). The Gemini models, served on chat
completions alone, answered 400 "invalid request body" to a turn whose
whole content was "hi" — the tool schemas' anyOf of object branches is
what Copilot's Gemini rejects, as #3931's comparisons showed (the same
request with the unions as oneOf came back 200). A union whose branches
are provably disjoint now goes as oneOf, renamed in place: both branches
require a string field whose enum or const values never meet, or one
requires a field the other forbids through additionalProperties: false.
A union that can't be proved stays an anyOf, Copilot's other models are
untouched.

Grok 4.7, served on /responses, answered 422 "422 Unprocessable Entity:
Unprocessable Entity" six requests in a row: xAI behind Copilot takes no
custom tool (#3392), and Copilot's answer in front of Grok says no more
than the status (#378), so the refusal-learner that serves the vendors
whose answer names them (#2656) has nothing to read. A Codex turn with a
custom tool to a Grok model on Copilot is translated from the first ask,
as a learned refusal does elsewhere.

Run (go test -tags nogui ./internal/gateway):

- TestCopilotGeminiTakesCodexUnionsAsOneOf: a fake Copilot refusing a
  tool schema with an anyOf, word for word as #4374's Gemini record, is
  answered; the union goes out as oneOf
- TestCopilotGeminiKeepsUnprovenUnions: a union no one can prove stays
  an anyOf and the refusal still reaches the client
- TestCopilotGrokTakesCustomToolsAsFunctions: a fake Copilot whose Grok
  refuses a custom tool with #2951's bare 422 is answered; apply_patch
  goes as a function, GPT on the same /responses keeps it as it came
- RED on the parent commit: the first and third fail with the refusals
  named above; the second holds before and after — it guards that only
  what is provable is renamed

Fixes #4374

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/copilot_gemini_grok_test.go | 272 +++++++++++++++++++
 internal/gateway/copilot_gemini_schema.go    | 165 +++++++++++
 internal/gateway/gateway.go                  |  15 +-
 3 files changed, 451 insertions(+), 1 deletion(-)
 create mode 100644 internal/gateway/copilot_gemini_grok_test.go
 create mode 100644 internal/gateway/copilot_gemini_schema.go

diff --git a/internal/gateway/copilot_gemini_grok_test.go b/internal/gateway/copilot_gemini_grok_test.go
new file mode 100644
index 000000000..7758163cb
--- /dev/null
+++ b/internal/gateway/copilot_gemini_grok_test.go
@@ -0,0 +1,272 @@
+package gateway
+
+import (
+	"bytes"
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #4374 (RoyShen12): Codex Desktop through Copilot — the Gemini models all
+// came back 400 "Copilot: invalid request body" on a turn whose only
+// content was "hi", while a tool-less provider test came back 200, and
+// Grok 4.7 came back 422 "Copilot: 422 Unprocessable Entity: Unprocessable
+// Entity", six gateway requests in a row, all on the first turn. The two
+// speak different wires: a Copilot Gemini model is served on chat
+// completions alone, so Codex's Responses turn is translated for it, and
+// Grok is served on /responses, so its turn is relayed as it came.
+
+// copilotUnionsRequest is Codex's first turn with create_thread, its
+// target the disjoint object union #3931's comparisons pinned as the
+// refusal (each branch requires a "type" whose value no other branch
+// takes), as Codex Desktop declares it.
+const copilotUnionsRequest = `{"model":"copilot/gemini-3.8-flash","stream":true,"store":false,
+  "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],
+  "tools":[{"type":"function","name":"create_thread","description":"Create a thread.",
+    "parameters":{"type":"object","properties":{"target":{"description":"Where the thread lives.",
+      "anyOf":[{"type":"object","properties":{"type":{"type":"string","enum":["project"]},"project_id":{"type":"string"}},
+               "required":["type","project_id"],"additionalProperties":false},
+              {"type":"object","properties":{"type":{"type":"string","enum":["projectless"]}},
+               "required":["type"],"additionalProperties":false}]}},
+      "required":["target"],"additionalProperties":false}}]}`
+
+// TestCopilotGeminiTakesCodexUnionsAsOneOf: Copilot's Gemini turned every
+// tool-bearing turn of Codex's away 400 "invalid request body" (#4374,
+// #3931's comparisons: the same request with the disjoint unions as oneOf
+// came back 200). What Copilot's Gemini rejects is the anyOf, so a
+// provably disjoint one goes as oneOf, which says the same to a model
+// choosing what to call.
+func TestCopilotGeminiTakesCodexUnionsAsOneOf(t *testing.T) {
+	var mu sync.Mutex
+	var sent []string
+	copilotTurnFake(t, map[string]string{
+		"gemini-3.8-flash": `["/chat/completions"]`,
+	}, nil, func(m string, b []byte) bool {
+		// as #3931's live comparisons show: a tool whose schema carries an
+		// object anyOf turns the whole request away, whatever else it says
+		return bytes.Contains(b, []byte(`"anyOf"`))
+	}, "invalid request body", http.StatusBadRequest, &sent)
+
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(copilotUnionsRequest)))
+	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "hi") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 1 {
+		t.Fatalf("Copilot was asked %d times", len(sent))
+	}
+	if strings.Contains(sent[0], `"anyOf"`) {
+		t.Errorf("Codex's disjoint union went to Copilot's Gemini as anyOf, which it turns away: %s", sent[0])
+	}
+	if !strings.Contains(sent[0], `"oneOf"`) {
+		t.Errorf("the union went as neither anyOf nor oneOf: %s", sent[0])
+	}
+}
+
+// copilotOverlappingRequest carries a union no one can prove disjoint
+// (neither branch requires anything, neither forbids a field): an anyOf
+// to every vendor, oneOf or not.
+const copilotOverlappingRequest = `{"model":"copilot/gemini-3.8-flash","stream":true,"store":false,
+  "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],
+  "tools":[{"type":"function","name":"draw","description":"Draw a shape.",
+    "parameters":{"type":"object","properties":{"shape":{"description":"The shape.",
+      "anyOf":[{"type":"object","properties":{"round":{"type":"boolean"}}},
+              {"type":"object","properties":{"square":{"type":"boolean"}}}]}}}}]}`
+
+// TestCopilotGeminiKeepsUnprovenUnions: only what is provably disjoint
+// goes as oneOf. A union whose branches can't be told apart stays an
+// anyOf, and Copilot's refusal of it still reaches the client, as it did
+// before (#4374's Gemini turns were all refused; this union is one the
+// conversion leaves as it came).
+func TestCopilotGeminiKeepsUnprovenUnions(t *testing.T) {
+	var mu sync.Mutex
+	var sent []string
+	copilotTurnFake(t, map[string]string{
+		"gemini-3.8-flash": `["/chat/completions"]`,
+	}, nil, func(m string, b []byte) bool {
+		return bytes.Contains(b, []byte(`"anyOf"`))
+	}, "invalid request body", http.StatusBadRequest, &sent)
+
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(copilotOverlappingRequest)))
+	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "invalid request body") {
+		t.Fatalf("%d %s", rec.Code, rec.Body.String())
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 0 {
+		t.Errorf("a refused turn was recorded as taken: %q", sent)
+	}
+}
+
+// TestCopilotGrokTakesCustomToolsAsFunctions: Grok on Copilot is served on
+// /responses, and Codex's turn went to it as it came — with apply_patch, a
+// custom tool, which xAI behind Copilot takes none of (#3392). Copilot's
+// answer in front of Grok says no more than the status (#378's bare 400),
+// so nothing in "422 Unprocessable Entity: Unprocessable Entity" (#2951,
+// #4374: six requests in a row, all refused) tells magpie what to learn,
+// and every turn failed. The custom tools go as functions from the first
+// ask, as a refusal already taught magpie to do for the vendors whose
+// answer names them (#2656, #3392); a model Copilot serves on the same
+// /responses that takes them (GPT) is relayed as it came.
+func TestCopilotGrokTakesCustomToolsAsFunctions(t *testing.T) {
+	var mu sync.Mutex
+	var sent []string
+	copilotTurnFake(t, map[string]string{
+		"grok-4.7": `["/responses"]`,
+		"gpt-6.1":  `["/responses"]`,
+	}, func(m string, b []byte) (int, string) {
+		if m == "grok-4.7" && hasCustomTool(b) {
+			return http.StatusUnprocessableEntity, `{"error":{"message":"422 Unprocessable Entity: Unprocessable Entity","type":"invalid_request_error"}}`
+		}
+		return 0, ""
+	}, nil, "", 0, &sent)
+
+	turn := func(model string) (int, string) {
+		body := `{"model":"` + model + `","stream":true,"store":false,"reasoning":{"effort":"low"},
+		  "input":[{"role":"user","content":"hi check current time"}],
+		  "tools":[{"type":"custom","name":"apply_patch","description":"Apply a patch.","format":{"type":"text"}},
+		           {"type":"function","name":"shell","description":"Run a command.","strict":false,
+		            "parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}]}`
+		rec := httptest.NewRecorder()
+		New().Handler().ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body)))
+		return rec.Code, rec.Body.String()
+	}
+	code, got := turn("copilot/grok-4.7")
+	if code != 200 || !strings.Contains(got, "DONE") {
+		t.Fatalf("grok-4.7: %d %s", code, got)
+	}
+	code, got = turn("copilot/gpt-6.1")
+	if code != 200 || !strings.Contains(got, "DONE") {
+		t.Fatalf("gpt-6.1: %d %s", code, got)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	var grok, gpt string
+	for _, s := range sent {
+		if strings.HasPrefix(s, "grok-4.7 ") && grok == "" {
+			grok = s
+		}
+		if strings.HasPrefix(s, "gpt-6.1 ") && gpt == "" {
+			gpt = s
+		}
+	}
+	if grok == "" || gpt == "" {
+		t.Fatalf("Copilot was asked: %q", sent)
+	}
+	if strings.Contains(grok, `"type":"custom"`) {
+		t.Errorf("Grok was handed Codex's custom tool, which it turns every turn away over: %s", grok)
+	}
+	if !strings.Contains(grok, `"name":"apply_patch"`) {
+		t.Errorf("apply_patch not offered Grok as a function: %s", grok)
+	}
+	if !strings.Contains(gpt, `"type":"custom"`) {
+		t.Errorf("GPT was not handed Codex's custom tool as it came: %s", gpt)
+	}
+}
+
+// copilotTurnFake is a Copilot account whose api serves the models named,
+// on the endpoints their lists give (a "/responses" path and a
+// "/chat/completions" one). refuse says whether Copilot's /responses turns
+// a turn away, and with what; chatRefuse says the same of its chat
+// completions, answered with chatStatus and chatMessage. The bodies of the
+// turns Copilot takes are appended to sent as "<model> <body>".
+func copilotTurnFake(t *testing.T, models map[string]string, refuse func(model string, body []byte) (int, string),
+	chatRefuse func(model string, body []byte) bool, chatMessage string, chatStatus int, sent *[]string,
+) {
+	t.Helper()
+	fresh(t)
+	cfg := os.Getenv("XDG_CONFIG_HOME")
+	os.MkdirAll(filepath.Join(cfg, "github-copilot"), 0o755)
+	os.WriteFile(filepath.Join(cfg, "github-copilot", "apps.json"), mustJSON(map[string]any{
+		"github.com:Iv1.x": map[string]any{"user": "echo", "oauth_token": "gho_echo"},
+	}), 0o600)
+
+	var mu sync.Mutex
+	note := func(m string, b []byte) {
+		mu.Lock()
+		*sent = append(*sent, m+" "+string(b))
+		mu.Unlock()
+	}
+	// the account's model list, as Copilot's would have it: each model on
+	// the APIs its endpoints give
+	var live []catalog.Model
+	for id, endpoints := range models {
+		var apis []string
+		for _, e := range strings.Split(strings.Trim(strings.ReplaceAll(endpoints, "/v1/messages", "/chat/completions"), `[]"`), ",") {
+			switch strings.TrimSpace(e) {
+			case "/responses":
+				apis = append(apis, "responses")
+			default:
+				apis = append(apis, "chat")
+			}
+		}
+		live = append(live, catalog.Model{ID: id, Name: id, APIs: apis, Efforts: []string{"low", "medium", "high"}})
+	}
+	if err := catalog.SaveLive("copilot", "https://api.githubcopilot.com", live); err != nil {
+		t.Fatalf("save live: %v", err)
+	}
+	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		switch r.URL.Path {
+		case "/models":
+			io.WriteString(w, `{"data":[]}`)
+		case "/responses":
+			m := modelOf(b)
+			if refuse != nil {
+				if status, message := refuse(m, b); status != 0 {
+					w.Header().Set("Content-Type", "application/json")
+					w.WriteHeader(status)
+					io.WriteString(w, message)
+					return
+				}
+			}
+			note(m, b)
+			w.Header().Set("Content-Type", "text/event-stream")
+			io.WriteString(w, sse(
+				`data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
+				`data: {"type":"response.output_text.delta","delta":"DONE"}`,
+				`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":1}}}`))
+		case "/chat/completions":
+			m := modelOf(b)
+			if chatRefuse != nil && chatRefuse(m, b) {
+				w.Header().Set("Content-Type", "application/json")
+				w.WriteHeader(chatStatus)
+				io.WriteString(w, `{"error":{"code":null,"message":"`+chatMessage+`","param":null,"type":"invalid_request_error"}}`)
+				return
+			}
+			note(m, b)
+			w.Header().Set("Content-Type", "text/event-stream")
+			io.WriteString(w, sse(
+				`data: {"id":"c1","model":"`+m+`","choices":[{"delta":{"content":"hi"}}]}`,
+				`data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}`,
+				`data: [DONE]`))
+		default:
+			w.WriteHeader(404)
+		}
+	}))
+	t.Cleanup(apiSrv.Close)
+	ghSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if strings.HasSuffix(r.URL.Path, "/token") {
+			json.NewEncoder(w).Encode(map[string]any{"token": "sess", "expires_at": time.Now().Add(time.Hour).Unix(), "endpoints": map[string]string{"api": apiSrv.URL}})
+			return
+		}
+		io.WriteString(w, `{"copilot_plan":"individual"}`)
+	}))
+	t.Cleanup(ghSrv.Close)
+	oldTok, oldUser := provider.CopilotTokenURL, provider.CopilotUserURL
+	provider.CopilotTokenURL, provider.CopilotUserURL = ghSrv.URL+"/token", ghSrv.URL+"/user"
+	t.Cleanup(func() { provider.CopilotTokenURL, provider.CopilotUserURL = oldTok, oldUser })
+}
diff --git a/internal/gateway/copilot_gemini_schema.go b/internal/gateway/copilot_gemini_schema.go
new file mode 100644
index 000000000..9ece2788b
--- /dev/null
+++ b/internal/gateway/copilot_gemini_schema.go
@@ -0,0 +1,165 @@
+package gateway
+
+import (
+	"bytes"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A Copilot Gemini model is served on chat completions alone, so Codex's
+// tools go to it through the translation, schemas as the client declared
+// them — and Copilot turns every tool-bearing turn of Codex Desktop's away
+// 400 "invalid request body" on them (#4374, as #3931's comparisons
+// showed: the same request with the unions as oneOf came back 200, and
+// nothing else about the tools — descriptions, strict, required — made the
+// difference). What it rejects is a tool schema's anyOf of object branches,
+// so one whose branches are provably disjoint goes as oneOf, which says
+// the same to a model choosing what to call: at most one branch can match,
+// whichever says it.
+//
+// Disjoint is proved as #3931's fix did, and only so: two branches are
+// apart when one requires a field of a string whose values (enum, const)
+// the other's required field of that name never takes, or when one
+// requires a field the other forbids through additionalProperties: false
+// (with no patternProperties beside it, which would admit the name). A
+// union that can't be proved — nullable ones among them — stays an anyOf.
+func copilotGeminiToolUnions(p provider.Provider, to provider.Protocol, body []byte) []byte {
+	if to != provider.Chat || p.Account == nil || p.Account.Agent != "copilot" ||
+		!geminiNamed(gjson.GetBytes(body, "model").String()) {
+		return body
+	}
+	if !bytes.Contains(body, []byte(`"anyOf"`)) {
+		return body
+	}
+	var at []int
+	gjson.GetBytes(body, "tools").ForEach(func(_, tool gjson.Result) bool {
+		for _, path := range []string{"function.parameters", "parameters", "input_schema"} {
+			collectCopilotUnions(body, tool.Get(path), &at)
+		}
+		return true
+	})
+	if len(at) == 0 {
+		return body
+	}
+	// renamed in place, the same length, so nothing else of the body moves
+	// and a cache keeps its prefix
+	out := bytes.Clone(body)
+	for _, i := range at {
+		copy(out[i:], `"oneOf"`)
+	}
+	return out
+}
+
+// collectCopilotUnions adds where each anyOf of provably disjoint object
+// branches under node, a tool's schema, starts in body: a key, not a
+// property of that name.
+func collectCopilotUnions(body []byte, node gjson.Result, at *[]int) {
+	switch {
+	case node.IsArray():
+		node.ForEach(func(_, v gjson.Result) bool {
+			collectCopilotUnions(body, v, at)
+			return true
+		})
+	case node.IsObject():
+		if union := node.Get("anyOf"); union.Exists() && !node.Get("oneOf").Exists() && disjointObjectBranches(union) {
+			if i := keyBefore(body, union.Index, `"anyOf"`); i >= 0 {
+				*at = append(*at, i)
+			}
+		}
+		node.ForEach(func(key, v gjson.Result) bool {
+			switch key.String() {
+			case "properties", "$defs", "definitions", "dependentSchemas", "patternProperties":
+				v.ForEach(func(_, s gjson.Result) bool {
+					collectCopilotUnions(body, s, at)
+					return true
+				})
+			case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema":
+				collectCopilotUnions(body, v, at)
+			}
+			return true
+		})
+	}
+}
+
+// disjointObjectBranches is whether union, an anyOf, is of object branches
+// only and every two of them are proved apart.
+func disjointObjectBranches(union gjson.Result) bool {
+	if !union.IsArray() {
+		return false
+	}
+	branches := union.Array()
+	if len(branches) < 2 {
+		return false
+	}
+	for i, a := range branches {
+		if a.Get("type").String() != "object" || a.Get(`\$ref`).Exists() {
+			return false
+		}
+		for _, b := range branches[:i] {
+			if !objectBranchesApart(a, b) && !objectBranchesApart(b, a) {
+				return false
+			}
+		}
+	}
+	return true
+}
+
+// objectBranchesApart is whether a is proved apart from b: a required
+// field of a that b never takes. Either b forbids the field outright
+// (additionalProperties: false, no patternProperties to admit it), or b
+// requires it too and the string values (enum, const) the two say for it
+// never meet — a field b holds optional is one b may leave out, which is
+// every value of a's.
+func objectBranchesApart(a, b gjson.Result) bool {
+	bProps := b.Get("properties").Map()
+	for _, name := range a.Get("required").Array() {
+		if name.Type != gjson.String {
+			continue
+		}
+		field := name.String()
+		bProp, there := bProps[field]
+		if !there {
+			if b.Get("additionalProperties").Type == gjson.False && !b.Get("patternProperties").Exists() {
+				return true
+			}
+			continue
+		}
+		required := false
+		for _, other := range b.Get("required").Array() {
+			required = required || other.Type == gjson.String && other.String() == field
+		}
+		av, bv := schemaStringValues(a.Get("properties").Map()[field]), schemaStringValues(bProp)
+		if !required || len(av) == 0 || len(bv) == 0 {
+			continue
+		}
+		shared := false
+		for v := range av {
+			shared = shared || bv[v]
+		}
+		if !shared {
+			return true
+		}
+	}
+	return false
+}
+
+// schemaStringValues is the string values (enum, const) of schema, nil
+// when they can't be read whole (a $ref, a value that isn't a string).
+func schemaStringValues(schema gjson.Result) map[string]bool {
+	if schema.Get(`\$ref`).Exists() {
+		return nil
+	}
+	values := schema.Get("enum").Array()
+	if c := schema.Get("const"); c.Type == gjson.String {
+		values = []gjson.Result{c}
+	}
+	out := map[string]bool{}
+	for _, v := range values {
+		if v.Type != gjson.String {
+			return nil
+		}
+		out[v.String()] = true
+	}
+	return out
+}
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b19da3873..efae4a3f8 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4541,7 +4541,19 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// (custom_tool.go, #2656): translated on the client's own API, which
 	// offers them as functions
 	customOff := func() bool {
-		return from == provider.Responses && !s.fits(p.ID, customToolRefused(model), from) && hasCustomTool(body)
+		if from != provider.Responses || !hasCustomTool(body) {
+			return false
+		}
+		// Grok's, on Copilot's /responses in front of it: xAI takes no
+		// custom tool (#3392), and Copilot's answer says no more than the
+		// status — "422 Unprocessable Entity: Unprocessable Entity"
+		// (#2951, #4374: six requests of one turn, all refused) — so
+		// nothing tells magpie what to learn from. They go as functions
+		// from the first ask.
+		if p.Account != nil && p.Account.Agent == "copilot" && grokModel(model) {
+			return true
+		}
+		return !s.fits(p.ID, customToolRefused(model), from)
 	}
 	if relay && !keep && customOff() {
 		relay, ownAPI = false, true
@@ -4740,6 +4752,7 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 	body = deepseekTokenField(p, to, body)
 	body = s.chatTokenField(p, to, body)
 	body = toolOneOfAsAnyOf(p, to, body)
+	body = copilotGeminiToolUnions(p, to, body)
 	body = kimiToolEnumTypes(p, to, body)
 	body = kimiToolRefTypes(p, to, body)
 	body = geminiToolTypes(body)
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4374-copilot-gemini-grok](https://github.com/ggbdpq/magpie/tree/fix/4374-copilot-gemini-grok) (head `ced7c173f29f00292a1d817e320cea110c2bb1f5`).
