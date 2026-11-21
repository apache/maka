**Symptom** — as reported: a request carrying `web_search_20250305` to a ZCode plugin model (`zcode/GLM-5.3`) answers 200 with `server_tool_use: 0`, the model saying it has no search tool, while a custom GLM provider with `search=yes` searches on the same machine. `magpie provider set zcode search=yes` was taken by the CLI and had no effect.

**Minimal repro** — offline, on `de7953e3b`: the repo's fake plugin as a ZCode-shaped provider (GLM-5.3 on Anthropic's API, no `searches` in its config hook — the plugin's own word is empty, as the report's plugin metadata shows), a vendor recording what it is offered, `search=yes` saved by hand as the CLI saves it, then a non-streaming `/v1/messages` request declaring the tool. The vendor is asked with no tools at all; `Find` no longer knows `searches` either.

**Root cause** — `accountSettings` in `internal/provider/provider.go`, the one list a signed-in account's settings go through both ways (the #4738 list), copied none of `Searches`: `Save` wrote providers.json without it and `withPicks` read none back, so the built provider kept only what its plugin declared (`pp.Searches`, #2027). On a plugin that declares nothing, `searchesItself`'s `saidTo` stays false on the Anthropic API, so the translated request was built without the web search tool — "only a provider that searches by itself is asked to". The upstream runs the tool itself (bigmodel's Anthropic API, as the working `glm` provider proves); only magpie was never told.

**Fix** — `accountSettings` carries `Searches` as a one-way merge (`a.Searches || pk.Searches`): the user's `search=yes` is kept, a `search=no` takes back only the user's yes, and a plugin's own `searches` is never read as false for one saying nothing. Plus `internal/gateway/zcode_search_test.go`: the repro above as a test, asserting the vendor is offered the client's web search.

**Verification**

| Test | Without the fix | With the fix |
| --- | --- | --- |
| `TestZCodePluginSearchYesKeepsTheTool` | FAIL: `search=yes was not kept on the plugin's provider`; `the vendor was offered null` | PASS |

`go test -tags nogui -count=1 ./internal/provider/` (102s) and `./internal/gateway/` on darwin/arm64 at `4073c3652` — the gateway run failed only the pre-documented `TestCodexPoolSaysTheClientsVersion` flake, green on re-run, my test green within the same run; the new test also passes with `-race`; `gofmt -l` clean; `go vet -tags nogui ./...` clean (the `internal/gui` cgo warning on darwin is pre-existing on the untouched gui package), `GOOS=linux` / `GOOS=windows` vet clean for both touched packages; `go build -tags nogui .` on darwin, linux and windows. Ablating the one line on its own turns the test red again — `search=yes was not kept`, the vendor offered no tools.

Who else reads `Searches`, checked and left as is: `searchRank` still forces it off before ranking (a relay said to search is spent only when named, #359); `namedSearcherRank` and `RelaysSaidToSearch` list a `search=yes` provider for hand-naming only; `searchesItself`'s account branch reads `saidTo` for a plugin provider only (`IsPlugin`), so built-in Claude, Codex and Copilot sign-ins behave as before; the GUI's provider editor saves through the same `Save`, so its tick is kept now too (it was dropped the same way before); backups and dav sync pass `searches` through unchanged.

**Not verified**: no real ZCode account against bigmodel's production endpoint — the reproduction is the package's stand-in plugin with a fake vendor, offline. The report's response shape (200, no `server_tool_use`) is matched by the test's before-fix state, not by a live call.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider: keep a signed-in account's search=yes (#4402) — git am applies it as is; SHA-256 first 16: 4d7f0cd75ffac113</summary>

```
From 4073c365287fd463f32d02ec597e092cb6b14882 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 04:27:34 +0800
Subject: [PATCH] provider: keep a signed-in account's search=yes (#4402)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

`magpie provider set zcode search=yes` was taken by the CLI and dropped
by Save: accountSettings, the one list a signed-in account's settings go
through both ways, copied none of Searches, so the word never reached the
gateway. searchesItself reads no Searches on a plugin whose config hook
says nothing (#2027), so a client's web_search_20250305 was stripped from
the translated request and the vendor was asked with no search tool at
all — the request answered 200 while the model said it had no search
tool. ZCode's GLM-5.3 is exactly there: bigmodel's Anthropic API runs the
tool (a custom GLM provider with search=yes searches on the same
machine), only the plugin declares nothing for magpie to read.

The user's yes is now kept, and a no takes back only the user's yes: a
plugin's own Searches is never read as false for one saying nothing.

What changed

- internal/provider/provider.go: accountSettings carries Searches as a
  one-way merge (a.Searches || pk.Searches), on both paths it serves —
  Save writing what the user set, withPicks reading it back beside the
  plugin's own declaration.
- internal/gateway/zcode_search_test.go: a ZCode-shaped plugin
  (FAKE_ZCODE) whose vendor records what it is asked; search=yes saved by
  hand as the CLI does, and the vendor must be offered the web_search
  tool the client declared.

Run

go test -tags nogui -run TestZCodePluginSearchYesKeepsTheTool ./internal/gateway/

fails without the provider change (search=yes not kept; the vendor was
offered no tools) and passes with it.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/zcode_search_test.go | 77 +++++++++++++++++++++++++++
 internal/provider/provider.go         |  5 ++
 2 files changed, 82 insertions(+)
 create mode 100644 internal/gateway/zcode_search_test.go

diff --git a/internal/gateway/zcode_search_test.go b/internal/gateway/zcode_search_test.go
new file mode 100644
index 000000000..c7fe7d81f
--- /dev/null
+++ b/internal/gateway/zcode_search_test.go
@@ -0,0 +1,77 @@
+package gateway
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A ZCode-shaped plugin (GLM-5.3 on Anthropic's API) whose upstream runs a
+// web search tool itself: bigmodel's Anthropic API answers
+// web_search_20250305 with server_tool_use and web_search_tool_result
+// blocks — a custom GLM provider with search=yes had it searching on the
+// same machine (#4402). The user says so with
+// `magpie provider set zcode search=yes`; the CLI took the word and Save
+// dropped it, as accountSettings keeps none of a signed-in account's
+// Searches. The client's web_search was then stripped from the translated
+// request, the vendor was offered no search tool, and the request still
+// said 200 — the model answered it had no search tool.
+func TestZCodePluginSearchYesKeepsTheTool(t *testing.T) {
+	t.Setenv("FAKE_ZCODE", "1")
+	var mu sync.Mutex
+	var sent []map[string]any
+	movedFake(t, "zcode", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		var q map[string]any
+		json.Unmarshal(b, &q)
+		mu.Lock()
+		sent = append(sent, q)
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`event: message_start`+"\n"+`data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"GLM-5.3","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}`,
+			`event: content_block_start`+"\n"+`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
+			`event: content_block_delta`+"\n"+`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}`,
+			`event: content_block_stop`+"\n"+`data: {"type":"content_block_stop","index":0}`,
+			`event: message_delta`+"\n"+`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
+			`event: message_stop`+"\n"+`data: {"type":"message_stop"}`))
+	}))
+	p, err := provider.Find("zcode")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.Searches {
+		t.Fatal("the plugin already says it searches; the test's word adds nothing")
+	}
+	q := *p
+	q.Searches = true // magpie provider set zcode search=yes
+	if err := provider.Save(q); err != nil {
+		t.Fatal(err)
+	}
+	if got, err := provider.Find("zcode"); err != nil {
+		t.Fatal(err)
+	} else if !got.Searches {
+		t.Errorf("search=yes was not kept on the plugin's provider")
+	}
+	rec := httptest.NewRecorder()
+	New().Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/messages",
+		strings.NewReader(`{"model":"zcode/GLM-5.3","max_tokens":100,"stream":false,"messages":[{"role":"user","content":"search the web for the latest Go release"}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":1}]}`)))
+	if rec.Code != http.StatusOK {
+		t.Fatalf("%d %s", rec.Code, rec.Body)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(sent) != 1 {
+		t.Fatalf("asked %d times", len(sent))
+	}
+	tools, _ := json.Marshal(sent[0]["tools"])
+	if !strings.Contains(string(tools), "web_search") {
+		t.Fatalf("the vendor was offered %s", tools)
+	}
+}
diff --git a/internal/provider/provider.go b/internal/provider/provider.go
index 9e9d8eb19..6414e80a5 100644
--- a/internal/provider/provider.go
+++ b/internal/provider/provider.go
@@ -863,6 +863,11 @@ func accountSettings(a, pk Provider) Provider {
 	a.SwitchOnly = pk.SwitchOnly
 	a.Sink, a.NoModels, a.BestInFamily = pk.Sink, pk.NoModels, pk.BestInFamily
 	a.NativeCompaction = pk.NativeCompaction
+	// a search=yes the user said of a subscription's or a plugin's provider
+	// (`magpie provider set zcode search=yes`): kept, and a no takes back
+	// only the user's yes — a plugin's own word for its upstream (#2027) is
+	// never read as false for one saying nothing (#4402, ZCode's WebSearch)
+	a.Searches = a.Searches || pk.Searches
 	a.PromptAsWritten = pk.PromptAsWritten
 	// a deferred tool a tool search loaded goes where it was loaded, set
 	// with `magpie provider set <id> additional-tools=on` (#2660, #4738)
-- 
2.50.1 (Apple Git-155)
```
</details>

Branch with the commit: [fix/4402-zcode-websearch-path](https://github.com/ggbdpq/magpie/tree/fix/4402-zcode-websearch-path) (head `4073c365287fd463f32d02ec597e092cb6b14882`).
