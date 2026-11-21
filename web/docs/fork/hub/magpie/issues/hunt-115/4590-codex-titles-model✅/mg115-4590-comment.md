**Summary**
With magpie as Codex's model provider, the Codex titles setting never took and thread titles fell back to the first message's truncation (#4590). The thread's title request — on Codex's own title model `gpt-5.6-luna` — reaches magpie's `/v1/responses` (`model_providers.magpie`'s base_url is magpie's /v1), where `codexOwnOffMagpie` (added in 4586307de for iuengei's case) puts any of Codex's own models on Codex's ChatGPT sign-in and answers 404 when no sign-in can be had. That check runs before `codexTitlesTo` is ever asked, so a title request died at the sign-in check and Codex silently named the thread after its first message, whatever the settings said. Codex's other hidden side calls (thread description, summary, composer prediction) on its own models were swept up the same way.

**Minimal repro**
- Codex with `model_provider = "magpie"` (magpie's own /v1), never signed in to ChatGPT (`~/.codex/auth.json` absent), no ChatGPT account in magpie; `gpt-5.6-luna` in `~/.codex/models_cache.json`.
- Settings → Codex titles → any model of magpie's.
- POST `/v1/responses` with `{"model":"gpt-5.6-luna",...}` and header `x-codex-turn-metadata: {"thread_source":"thread_title"}`: was `404` with `"gpt-5.6-luna" is one of Codex's own models ... open ~/.codex/auth.json: no such file or directory`, and the titles model was never asked.

**Root cause**
`handle` asks `codexOwnOffMagpie` before the `codexTitlesTo`/`codexDescriptionsTo`/`codexSummariesTo`/`codexPredictionsTo` group (gateway.go). A side call on a bare Codex model passes every one of `codexOwnOffMagpie`'s conditions (bare model, local, from Codex, no provider/group/stand-in serves it, it is one of Codex's own), and with no ChatGPT sign-in to be had it was answered 404 right there. Side calls are magpie's to answer further down `handle` — they should never have been candidates for Codex's sign-in. The timeline matches: 4586307de landed on 2026-10-29, and the reporter's usage ledger shows the rewrites stop after that date.

**Fix**
`codexOwnOffMagpie` returns early for a side-call kind (`thread_title`, `thread_title_reconsideration`, `title_generation`, `thread_description`, `thread_summary`, `composer_predictions`) so the request falls through to the settings-driven handlers as it did before 4586307de; a plain conversational turn on one of Codex's own models still goes on the sign-in as 4586307de says. Not tied to the name "luna" (your 6.1-luna note below is the same story): the check is by the request's kind, so whichever of Codex's own models the title turn asks on, the settings' model writes it.

**Verification**

| Check | Result |
| --- | --- |
| New `TestCodexSideCallOnOwnModelNotPutOnSignIn` (title, description; shruru's machine: no auth.json, gpt-5.6-luna cached, no ChatGPT account, settings → `fake/m1`) | red before the fix with the reporter's 404 verbatim; green after (200, the settings' model asked, `{"title"}`/`{"description"}` handed back) |
| Ablation (fix reverted, test kept) | both subtests red again |
| `TestCodexOwnModelOnMagpieThread{GoesOnSignIn,StaysHere,SaysWhy}` (4586307de's own tests) | pass — plain turns still go on the sign-in |
| `TestCodexTitlesSetting`, `TestCodexTitleOnMagpieProvider`, `TestCodexDescriptionsSetting`, `TestCodexDescriptionFallbackOnMagpie`, `TestTitleJSON*`, `TestNoDescription` | pass |
| `go test -tags nogui ./internal/gateway` (full package) | ok (532s), 0 failures |
| `gofmt -l internal/gateway` | clean |
| `go vet -tags nogui` darwin / GOOS=linux / GOOS=windows, `./internal/gateway` | ok |
| `go build -tags nogui` darwin/arm64, linux/amd64, windows/amd64 | ok (pre-existing cgo enum-conversion warnings in internal/gui/dockflap_darwin.go and trayimage_darwin.go, untouched) |

**Not verified**: a real Codex Desktop thread against real third-party providers (no ChatGPT/Codex environment here); the 10-29 400s in the reporter's ledger (21-72s, 25 records) predate 4586307de's landing that evening and were not reproduced.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
<details><summary>patch: gateway: Codex side calls on its own models stay with magpie, not its sign-in (#4590) — git am applies it as is; SHA-256 first 16: fdbf8b844dac5d2f</summary>

```
From bf8f29a8bf2ebbd4d47d6de610111b8d46ccd76f Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 16:24:59 +0800
Subject: [PATCH] gateway: Codex side calls on its own models stay with magpie,
 not its sign-in (#4590)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

shruru: with magpie as Codex's model provider, picking any model in the
Codex titles setting never took: the thread's title stayed the first
message's truncation, and a request for gpt-5.6-luna, Codex's own title
model, to /v1/responses was answered 404 "is one of Codex's own models...
open ~/.codex/auth.json: no such file or directory".

A thread started while magpie was Codex's provider sends to magpie's /v1
(model_providers.magpie's base_url is magpie's /v1), and since
4586307de a request there on one of Codex's own models is put on Codex's
ChatGPT sign-in, or answered 404 when no sign-in can be had — before
handle ever asks codexTitlesTo where the settings send a title. Codex's
hidden side calls (a thread's title, description, summary, a composer
prediction) on its own models were swept up in that: magpie has its own
answer for each (codexTitlesTo and its siblings, further down handle),
so with no ChatGPT account anywhere the title request died at the sign-in
check and Codex fell back to naming the thread after its first message,
whatever the settings said.

Now codexOwnOffMagpie leaves side calls where they stand; a plain turn on
one of Codex's own models goes on the sign-in as 4586307de says.

Tests (internal/gateway/codex_own_v1_test.go): shruru's machine — Codex
never signed in (no auth.json), gpt-5.6-luna in its models cache, no
ChatGPT account in magpie, titles and descriptions set to a magpie model;
a thread_title and a thread_description request to /v1/responses on
gpt-5.6-luna: was 404 "one of Codex's own models...", now 200 with the
{"title"} / {"description"} the settings' model wrote.

Run (darwin arm64, -tags nogui):
- go test -tags nogui -run 'TestCodexSideCallOnOwnModelNotPutOnSignIn|TestCodexOwnModelOnMagpieThread|TestCodexTitlesSetting|TestCodexTitleOnMagpieProvider|TestCodexDescriptionsSetting|TestCodexDescriptionFallbackOnMagpie' ./internal/gateway: ok
  (the new test was red before the fix, with the reporter's 404 verbatim)

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_own_v1.go      |  10 +++
 internal/gateway/codex_own_v1_test.go | 111 ++++++++++++++++++++++++++
 2 files changed, 121 insertions(+)

diff --git a/internal/gateway/codex_own_v1.go b/internal/gateway/codex_own_v1.go
index 7ad9d868a..7ad044118 100644
--- a/internal/gateway/codex_own_v1.go
+++ b/internal/gateway/codex_own_v1.go
@@ -36,6 +36,16 @@ func codexOwnOffMagpie(r *http.Request, body []byte, model string) (to *http.Req
 	if model == "" || strings.Contains(model, "/") || !local(r) {
 		return nil, ""
 	}
+	// one of Codex's hidden side calls on its own model — a thread's title
+	// or description, a summary, a composer prediction — is magpie's to
+	// answer where it stands (codexTitlesTo and its siblings, further down
+	// handle), never to put on Codex's ChatGPT sign-in: with no sign-in to
+	// be had (no ChatGPT account in magpie, Codex itself never signed in)
+	// the request was answered 404 and Codex named the thread after its
+	// first message, whatever the settings said (#4590)
+	if k := requestCallKind(r.Header, requestSessionMetadata(r.Header, body)); isTitleKind(k) || isDescriptionKind(k) || isSummaryKind(k) || isPredictionKind(k) {
+		return nil, ""
+	}
 	if !fromCodex(r.Header) && agentOf(r) != "codex" {
 		return nil, ""
 	}
diff --git a/internal/gateway/codex_own_v1_test.go b/internal/gateway/codex_own_v1_test.go
index d02bddad2..62a6db57c 100644
--- a/internal/gateway/codex_own_v1_test.go
+++ b/internal/gateway/codex_own_v1_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"encoding/json"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -11,6 +12,7 @@ import (
 
 	"github.com/yetone/magpie/internal/access"
 	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/settings"
 )
 
 // codexOwnOffMagpieSetup: Codex signed in to ChatGPT, its models cache
@@ -140,3 +142,112 @@ func TestCodexOwnModelOnMagpieThreadSaysWhy(t *testing.T) {
 		}
 	}
 }
+
+// codexOwnSideCall is one of Codex's hidden side calls (a thread's title
+// or description) sent to magpie's own /v1 on one of Codex's own models,
+// as it is when the thread was started while magpie was Codex's provider
+// (model_provider = "magpie", whose base_url is magpie's /v1) and Codex
+// asks on its own title model, gpt-5.6-luna.
+func codexOwnSideCall(t *testing.T, kind, model string) *httptest.ResponseRecorder {
+	t.Helper()
+	var text, schema string
+	switch kind {
+	case "thread_title":
+		text = "Generate a concise title. User prompt:\nfix the login bug"
+		schema = `{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":36}},"required":["title"],"additionalProperties":false}`
+	case "thread_description":
+		text = "Describe the thread"
+		schema = `{"type":"object","properties":{"description":{"type":"string","minLength":1}},"required":["description"],"additionalProperties":false}`
+	}
+	body := `{"model":"` + model + `","stream":true,"reasoning":{"effort":"low"},"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":` + strconvQuote(text) + `}]}],` +
+		`"text":{"format":{"type":"json_schema","name":"codex_output_schema","strict":true,"schema":` + schema + `}}}`
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/responses", strings.NewReader(body))
+	req.RemoteAddr = "127.0.0.1:51000"
+	req.Header.Set("Content-Type", "application/json")
+	req.Header.Set("User-Agent", "codex_cli_rs/0.164.0 (Mac OS 26.2.0; arm64) Terminal")
+	req.Header.Set("Originator", "codex_cli_rs")
+	req.Header.Set("Authorization", "Bearer "+Token)
+	req.Header.Set("session_id", kind+"-thread")
+	req.Header.Set("x-codex-turn-metadata", `{"thread_source":"`+kind+`","parent_thread_id":"main-chat"}`)
+	New().Handler().ServeHTTP(rec, req)
+	return rec
+}
+
+// codexOwnSideCallEnv is shruru's machine for #4590: Codex never signed in
+// to ChatGPT (no ~/.codex/auth.json, on purpose), so magpie can read no
+// sign-in of its; its models cache still lists gpt-5.6-luna, and magpie
+// has no ChatGPT account either. The titles and descriptions settings name
+// a model of magpie's.
+func codexOwnSideCallEnv(t *testing.T) *fake {
+	t.Helper()
+	fresh(t) // no agent signed in anywhere
+	f := &fake{t: t}
+	setup(t, provider.Chat, f)
+	home := os.Getenv("HOME")
+	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"),
+		[]byte(`{"etag":"e1","models":[{"slug":"gpt-5.6-luna","display_name":"gpt-5.6-luna","priority":1}]}`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	provider.ForgetAccounts()
+	t.Cleanup(provider.ForgetAccounts)
+	save := func(name, v string) {
+		t.Helper()
+		st := settings.Load()
+		switch name {
+		case "titles":
+			st.CodexTitles = v
+		case "descriptions":
+			st.CodexDescriptions = v
+		}
+		if err := settings.Save(st); err != nil {
+			t.Fatal(err)
+		}
+	}
+	save("titles", "fake/m1")
+	save("descriptions", "fake/m1")
+	return f
+}
+
+// A hidden side call of Codex's that lands on /v1 on one of Codex's own
+// models — a thread's title or description, the thread started while
+// magpie was Codex's provider — is magpie's to answer (codexTitlesTo and
+// codexDescriptionsTo, further down handle), never to put on Codex's
+// ChatGPT sign-in: with no sign-in to be had (no ChatGPT account in
+// magpie, Codex itself never signed in) the request was answered 404 and
+// Codex named the thread after its first message, whatever the settings
+// said (#4590).
+func TestCodexSideCallOnOwnModelNotPutOnSignIn(t *testing.T) {
+	t.Run("title", func(t *testing.T) {
+		f := codexOwnSideCallEnv(t)
+		f.reply = sse(
+			`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Fix login bug"}}]}`,
+			`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":4}}`,
+			`data: [DONE]`)
+		rec := codexOwnSideCall(t, "thread_title", "gpt-5.6-luna")
+		if text, _ := outputText(t, rec.Body.String()); rec.Code != 200 || text != `{"title":"Fix login bug"}` || f.calls != 1 {
+			t.Fatalf("a title on gpt-5.6-luna: %d %q, upstream %d", rec.Code, rec.Body.String(), f.calls)
+		}
+		var sent struct {
+			Model string `json:"model"`
+		}
+		json.Unmarshal(f.got, &sent)
+		if sent.Model != "m1" {
+			t.Errorf("the titles model was asked for %q", sent.Model)
+		}
+	})
+	t.Run("description", func(t *testing.T) {
+		f := codexOwnSideCallEnv(t)
+		f.reply = sse(
+			`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Reviewed the routing change"}}]}`,
+			`data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":8}}`,
+			`data: [DONE]`)
+		rec := codexOwnSideCall(t, "thread_description", "gpt-5.6-luna")
+		if text, _ := outputText(t, rec.Body.String()); rec.Code != 200 || text != `{"description":"Reviewed the routing change"}` || f.calls != 1 {
+			t.Fatalf("a description on gpt-5.6-luna: %d %q, upstream %d", rec.Code, rec.Body.String(), f.calls)
+		}
+	})
+}
-- 
2.50.1 (Apple Git-155)

```
</details>

Branch with the commit: [hunt115-b2-4590](https://github.com/ggbdpq/magpie/tree/hunt115-b2-4590) (head `bf8f29a8bf2ebbd4d47d6de610111b8d46ccd76f`).
