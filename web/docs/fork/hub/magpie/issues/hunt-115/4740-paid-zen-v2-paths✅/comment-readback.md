Paid Zen and OpenCode Go now take the paths OpenCode 2 reads them on, the same move #3491 made for the free ones: `OpenCodeFreeURL` is `OpenCodeV2URL`, and both seams that ask it — the gateway's `forwardOnce` (relayed and translated requests alike) and the Test button's `tiny` — now ask it for every request to OpenCode's gateway, paid ones included. On this issue's first bullet, the catalogs and docs agree on every protocol (read 2026-11-01):

| protocol | v2 catalog, opencode / opencode-go (models.opencode.ai/experimental/v2.0/api.json) | models.dev/api.json | opencode.ai/v2 docs |
| --- | --- | --- | --- |
| Chat, Responses (Zen) | `/inference/openai/v1` | `/inference/openai/v1` | `/inference/openai/v1/chat/completions`, `/inference/openai/v1/responses` |
| Messages (Zen) | `/inference/anthropic/v1` | — | `/inference/anthropic/v1/messages` |
| Gemini (Zen) | `/inference/google/v1beta` | — | `/inference/google/v1beta/models/…` |
| Chat, Responses (Go) | `/inference/go/openai/v1` | `/inference/go/openai/v1` | `/inference/go/openai/v1/chat/completions`, `…/responses` |
| Messages (Go) | `/inference/go/anthropic/v1` | — | `/inference/go/anthropic/v1/messages` |
| Gemini (Go) | `/inference/go/google/v1beta` | — | `/inference/go/google/v1beta/models/…` |

There is no `/zen` anywhere in either catalog. Probed live today, unauthenticated, one request each (400/401/410 = the path answers, 404 = nothing there): the 1.x paths answer (`/zen/v1/chat/completions` 400, `/zen/go/v1/chat/completions` 400), and so do all the targets above; the Gemini targets reach Google (`/inference/google/v1beta/models/gemini-3.5-flash:streamGenerateContent` 401 "Upstream request failed: Invalid credential"). One finding the catalog alone would not have given: the vendor paths October's docs once gave under `/zen/go` are dead — `/zen/go/openai/v1/chat/completions` and `/zen/go/anthropic/v1/messages` answer 404 — so a provider saved with those moves too, to `/inference/go/{openai,anthropic}/…` where the same paths answer.

Left where it was, on purpose: the models list (this issue's third bullet) does not live under the protocol paths — `/inference/openai/v1/models` and `/inference/go/openai/v1/models` answer 404, and the docs give the roots (`curl https://opencode.ai/inference/v1/models`, `curl https://opencode.ai/inference/go/v1/models`), which answer 200, as do the `/zen/v1/models` and `/zen/go/v1/models` magpie asks today; the list fetch doesn't go through the rewrite, so it stays on the roots. System One (`/zen/v1/systemone` and the catalog's `/inference/systemone/v1/systemone` both answer 400) and Go's usage (`/zen/go/v1/usage`, `/inference/go/v1/usage` both 401 AuthError) are asked outside this seam, as #3491 left them. Presets and `openCodeEndpoints` still fill 1.x bases — the rewrite is request-time, so saved providers move without a config migration, as #3491's did. And the rewrite now owns only the gateway's own depths (a bare root, `/v1/…`, `/go…`): a relay of the user's own at `…/inference/custom`, which the old blacklist would have rewritten to `/inference/openai/custom/…`, now goes as it came.

**Red without the fix** (base `9d08993c8`): with the two seams gated back to free models only and the tests kept, `go test -tags nogui -run 'TestOpenCodePaidOnV2Paths' ./internal/gateway` fails:
```
    opencode_wire_test.go:217: zen/kimi-k3 on /v1/chat/completions: asked [opencode.ai/zen/v1/chat/completions], want opencode.ai/inference/openai/v1/chat/completions first
```
so do `TestOpenCodeGoModelsGoOnTheirOwnAPI` (Go paid at `/zen/go/...`) and `TestOpenCodeV2URL`'s paid probe (`opencode_zen_test.go:208: paid probe https://opencode.ai/zen/v1/responses`), while every free-model row stays green — the mutation un-moves exactly the paid half. With the fix: `ok`.

| Check | Command | Result |
| --- | --- | --- |
| Focused | `go test -tags nogui -run 'TestOpenCode\|TestZenFree\|TestZenPublic' ./internal/gateway ./internal/provider` | ok |
| Packages | `go test -tags nogui -count=1 ./internal/provider ./internal/gateway` | ok (114s, 568s) |
| Race | `-race` over the focused set above | ok |
| gofmt | `gofmt -l internal/` | clean |
| vet | `go vet -tags nogui`, then `GOOS=linux`, `GOOS=windows` | clean |
| build | `go build -tags nogui`, then `GOOS=linux`, `GOOS=windows` | ok (darwin prints internal/gui's pre-existing cgo warnings, exit 0) |

Not verified: no paid key here, so no request has come back 200 on the new paths, and this issue's second bullet — a fixture captured from OpenCode 2.2.5 with a paid key — stays open for whoever has one; the evidence that 2.2.5 asks the catalog's `base_url` is the free capture in #3491 plus the docs, not a paid capture. Whether the gateway wants anything extra of a paid key at the new paths (beyond the 2.2.5 header set magpie has sent there since 9feb1024) is likewise untested against the real thing.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): paid OpenCode Zen and Go models take the v2 catalog's paths (#4740) — git am applies it as is; SHA-256 first 16: 8c071e2c06955cda</summary>

```patch
From 735b4ca9769f62d3846e88dfd9f002f3233b2322 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 20:54:16 +0800
Subject: [PATCH] fix(gateway): paid OpenCode Zen and Go models take the v2
 catalog's paths (#4740)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: OpenCodeFreeURL becomes OpenCodeV2URL and moves every
request to OpenCode's gateway, not the free ones alone, onto the paths
the v2 catalog (models.opencode.ai/experimental/v2.0/api.json, which
OpenCode 2.2.5 reads) gives on 2026-11-01 - Chat and Responses at
/inference/openai/v1, Messages at /inference/anthropic/v1, Gemini at
/inference/google/v1beta, and Go's under /inference/go (…/openai/v1,
…/anthropic/v1, …/google/v1beta). 1.x's /zen/v1 and /zen/go/v1 kept
answering, so #3491 had left the paid models on them; the vendor paths
Go's docs gave in October 2026 under /zen/go answer 404 today and move
too. The rewrite now owns only the gateway's own depths (a bare root,
/v1/…, /go…), so a relay of the user's own at …/inference/custom, which
the old blacklist would have mangled, goes as it came. The gateway's
forwardOnce and the Test button's tiny both ask it; the models list
(asked at the root's /v1/models, which the protocol paths don't take)
and System One's /systemone stay where they were.

Run: go test -tags nogui ./internal/provider ./internal/gateway (full
suites), TestOpenCodeV2URL and TestOpenCodePaidOnV2Paths red before the
fix on the parent of this commit; gofmt clean; vet -tags nogui clean on
darwin/linux/windows; build on all three.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/gateway.go                |  10 +-
 internal/gateway/opencode_gemini_test.go   |  31 +++---
 internal/gateway/opencode_wire_test.go     | 114 ++++++++++++++++++++-
 internal/gateway/zenfree.go                |   2 +-
 internal/gateway/zenfree_test.go           |   2 +-
 internal/provider/opencode_client.go       |  71 ++++++++++---
 internal/provider/opencode_session_test.go |   2 +-
 internal/provider/opencode_zen_test.go     |  47 +++++++--
 internal/provider/test.go                  |   6 +-
 9 files changed, 235 insertions(+), 50 deletions(-)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index b19da3873..54a554475 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -4831,11 +4831,13 @@ func (s *Server) forwardOnce(ctx context.Context, p provider.Provider, to provid
 		path, body = at, b
 	}
 	base := p.Base(to)
-	zenFree := p.IsOpenCode() && p.OpenCodeFree(gjson.GetBytes(body, "model").String())
-	if zenFree {
-		// Zen's free tier answers at OpenCode 2's paths alone (zenfree.go)
-		base = provider.OpenCodeFreeURL(base, to)
+	openCode := p.IsOpenCode()
+	if openCode {
+		// on the paths OpenCode 2 reads the model on, the v2 catalog's,
+		// paid models' among them (#4740)
+		base = provider.OpenCodeV2URL(base, to)
 	}
+	zenFree := openCode && p.OpenCodeFree(gjson.GetBytes(body, "model").String())
 	if mantleRoutes(p, to) {
 		// Bedrock Mantle serves each model under /v1 or /openai/v1
 		// (mantle.go)
diff --git a/internal/gateway/opencode_gemini_test.go b/internal/gateway/opencode_gemini_test.go
index ce98ccaf7..7ecd159cf 100644
--- a/internal/gateway/opencode_gemini_test.go
+++ b/internal/gateway/opencode_gemini_test.go
@@ -41,10 +41,11 @@ type openCodeAsk struct {
 	body                    []byte
 }
 
-// openCodeGeminiServer answers as OpenCode does (2026-10-14): a Gemini
-// model on Gemini's generateContent at /zen/v1 or /inference/go/v1, a
-// GLM on chat, and "Model does not support this protocol." for a model
-// asked on an API it isn't served on.
+// openCodeGeminiServer answers as OpenCode does: a Gemini model on
+// Gemini's generateContent at the Google routes the v2 catalog names
+// (/inference/google/v1beta, /inference/go/google/v1beta, #4740), a GLM
+// on chat, and "Model does not support this protocol." for a model asked
+// on an API it isn't served on.
 func openCodeGeminiServer(t *testing.T, s *Server) func() []openCodeAsk {
 	t.Helper()
 	var mu sync.Mutex
@@ -63,7 +64,7 @@ func openCodeGeminiServer(t *testing.T, s *Server) func() []openCodeAsk {
 		switch {
 		case r.Method != http.MethodPost:
 			return reply(404, "application/json", `{}`)
-		case gemini && (strings.HasPrefix(path, "/zen/v1/models/") || strings.HasPrefix(path, "/inference/go/v1/models/")):
+		case gemini && (strings.HasPrefix(path, "/inference/google/v1beta/models/") || strings.HasPrefix(path, "/inference/go/google/v1beta/models/")):
 			return reply(200, "text/event-stream", openCodeGeminiSSE)
 		case strings.Contains(path, ":") || strings.Contains(path, "/models/"):
 			return reply(404, "text/html", `<html>Not Found</html>`)
@@ -99,11 +100,12 @@ func serve(s *Server, path, body string) (int, string) {
 // went to /zen/go/v1/chat/completions, the one API it isn't served on,
 // and Go answered "Model does not support this protocol". models.dev
 // lists it for Google's SDK, so it is asked on Gemini's
-// streamGenerateContent at /inference/go/v1 (Go's /zen/go/v1 has none),
-// signed as OpenCode signs one: the key in x-goog-api-key and the
-// conversation in x-opencode-session. Whatever API the client spoke, it
-// is answered in it, and a client's reasoning effort is Gemini's
-// thinkingLevel.
+// streamGenerateContent, at the Google route of the inference API's Go
+// half the v2 catalog names (/inference/go/google/v1beta; Go's /zen/go
+// had none, and since #4740 the route is the catalog's), signed as
+// OpenCode signs one: the key in x-goog-api-key and the conversation in
+// x-opencode-session. Whatever API the client spoke, it is answered in
+// it, and a client's reasoning effort is Gemini's thinkingLevel.
 func TestOpenCodeGoGeminiModelOnGeminiAPI(t *testing.T) {
 	fresh(t)
 	writeCatalog(t, openCodeGeminiCatalog)
@@ -113,7 +115,7 @@ func TestOpenCodeGoGeminiModelOnGeminiAPI(t *testing.T) {
 	}
 	s := New()
 	took := openCodeGeminiServer(t, s)
-	const want = "opencode.ai/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse"
+	const want = "opencode.ai/inference/go/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse"
 	check := func(what string, code int, body string) openCodeAsk {
 		t.Helper()
 		asked := took()
@@ -179,7 +181,8 @@ func TestOpenCodeGoGeminiModelOnGeminiAPI(t *testing.T) {
 }
 
 // The sibling at Zen: its Gemini models (gemini-3-flash here) are asked
-// on Gemini's generateContent at /zen/v1, which relays them to Google.
+// on Gemini's generateContent at the Google route the v2 catalog names,
+// /inference/google/v1beta (#4740; 1.x's /zen/v1 relayed them to Google).
 // Each provider's other models stay on the API the client spoke: a GLM
 // is never asked on Gemini's.
 func TestOpenCodeZenGeminiAndOtherModelsUnchanged(t *testing.T) {
@@ -198,7 +201,7 @@ func TestOpenCodeZenGeminiAndOtherModelsUnchanged(t *testing.T) {
 
 	code, body := serve(s, "/v1/chat/completions", `{"model":"opencode-zen/gemini-3-flash","messages":[{"role":"user","content":"Say hi in one word"}]}`)
 	asked := took()
-	if len(asked) != 1 || asked[0].url != "opencode.ai/zen/v1/models/gemini-3-flash:streamGenerateContent?alt=sse" || asked[0].key != "sk-zen" || asked[0].session == "" {
+	if len(asked) != 1 || asked[0].url != "opencode.ai/inference/google/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse" || asked[0].key != "sk-zen" || asked[0].session == "" {
 		t.Errorf("zen gemini: asked %v (%d %s)", urlsOf(asked), code, body)
 	}
 	if code != 200 || gjson.Get(body, "choices.0.message.content").String() != "Hi." {
@@ -208,7 +211,7 @@ func TestOpenCodeZenGeminiAndOtherModelsUnchanged(t *testing.T) {
 	for _, id := range []string{"opencode-zen", "opencode-go"} {
 		code, body := serve(s, "/v1/chat/completions", `{"model":"`+id+`/glm-5.3","messages":[{"role":"user","content":"hi"}]}`)
 		asked := took()
-		root := map[string]string{"opencode-zen": "opencode.ai/zen/v1", "opencode-go": "opencode.ai/zen/go/v1"}[id]
+		root := map[string]string{"opencode-zen": "opencode.ai/inference/openai/v1", "opencode-go": "opencode.ai/inference/go/openai/v1"}[id]
 		if len(asked) != 1 || asked[0].url != root+"/chat/completions" || asked[0].auth != "Bearer "+map[string]string{"opencode-zen": "sk-zen", "opencode-go": "sk-go"}[id] {
 			t.Errorf("%s glm: asked %v", id, urlsOf(asked))
 		}
diff --git a/internal/gateway/opencode_wire_test.go b/internal/gateway/opencode_wire_test.go
index be9367414..0529f3a7e 100644
--- a/internal/gateway/opencode_wire_test.go
+++ b/internal/gateway/opencode_wire_test.go
@@ -56,9 +56,10 @@ func TestOpenCodeGoModelsGoOnTheirOwnAPI(t *testing.T) {
 	}
 	// Go's own answers: the model's API takes it (here 401, as Go answers
 	// a request with no key it knows, 2026-10-08), the other two turn it
-	// away as Go does with a key
-	own := map[string]string{"gpt-6-luna": "/zen/go/v1/responses", "grok-4.7": "/zen/go/v1/responses",
-		"muse-spark-1.3-contributor": "/zen/go/v1/responses", "minimax-m2.7": "/zen/go/v1/messages"}
+	// away as Go does with a key — at the v2 paths of the inference API's
+	// /inference/go the models are read at now (#4740)
+	own := map[string]string{"gpt-6-luna": "/inference/go/openai/v1/responses", "grok-4.7": "/inference/go/openai/v1/responses",
+		"muse-spark-1.3-contributor": "/inference/go/openai/v1/responses", "minimax-m2.7": "/inference/go/anthropic/v1/messages"}
 	var mu sync.Mutex
 	asked := map[string][]string{}
 	s := New()
@@ -102,8 +103,13 @@ func TestOpenCodeGoModelsGoOnTheirOwnAPI(t *testing.T) {
 			}
 			want := "opencode.ai" + own[model]
 			if own[model] == "" {
-				// GLM: on the API the client spoke
-				want = "opencode.ai/zen/go" + path
+				// GLM: on the API the client spoke, moved to the
+				// inference API's /inference/go (#4740)
+				if path == "/v1/messages" {
+					want = "opencode.ai/inference/go/anthropic/v1/messages"
+				} else {
+					want = "opencode.ai/inference/go/openai/v1" + strings.TrimPrefix(path, "/v1")
+				}
 			}
 			if got[0] != want {
 				t.Errorf("%s on %s: asked %v, want %s first (%d %s)", model, path, got, want, rec.Code, rec.Body)
@@ -115,6 +121,104 @@ func TestOpenCodeGoModelsGoOnTheirOwnAPI(t *testing.T) {
 	}
 }
 
+// openCodePaidCatalog is models.dev's opencode and opencode-go as they
+// name the APIs paid models are served on (2026-11-01): GPT through
+// @ai-sdk/openai, Claude and MiniMax through @ai-sdk/anthropic, Gemini
+// through @ai-sdk/google, the rest on the chat completions the provider's
+// npm names.
+const openCodePaidCatalog = `{
+  "opencode": {"id":"opencode","npm":"@ai-sdk/openai-compatible","api":"https://opencode.ai/inference/v1","models": {
+    "kimi-k3": {"id":"kimi-k3","name":"Kimi K3"},
+    "gpt-5.5": {"id":"gpt-5.5","name":"GPT-5.5","provider":{"npm":"@ai-sdk/openai"}},
+    "claude-sonnet-5": {"id":"claude-sonnet-5","name":"Claude Sonnet 5","provider":{"npm":"@ai-sdk/anthropic"}},
+    "gemini-3.5-flash": {"id":"gemini-3.5-flash","name":"Gemini 3.5 Flash","provider":{"npm":"@ai-sdk/google"}}}},
+  "opencode-go": {"id":"opencode-go","npm":"@ai-sdk/openai-compatible","api":"https://opencode.ai/inference/go/openai/v1","models": {
+    "kimi-k3": {"id":"kimi-k3","name":"Kimi K3"},
+    "gpt-6-luna": {"id":"gpt-6-luna","name":"GPT-6 Luna","provider":{"npm":"@ai-sdk/openai"}},
+    "minimax-m2.7": {"id":"minimax-m2.7","name":"MiniMax M2.7","provider":{"npm":"@ai-sdk/anthropic"}}}}
+}`
+
+// #4740: a paid OpenCode model — Zen's, asked with a key, and Go's — is
+// asked where OpenCode 2 reads it, on the paths the v2 catalog gives its
+// provider, not the 1.x /zen paths the free move (#3491) left it on. A
+// Gemini model is asked on the Google route the catalog names.
+func TestOpenCodePaidOnV2Paths(t *testing.T) {
+	fresh(t)
+	writeCatalog(t, openCodePaidCatalog)
+	for _, p := range []provider.Provider{
+		{ID: "zen", Name: "Zen", Key: "sk-zen",
+			Chat: "https://opencode.ai/zen/v1", Responses: "https://opencode.ai/zen/v1", Anthropic: "https://opencode.ai/zen",
+			Models: []string{"kimi-k3", "gpt-5.5", "claude-sonnet-5", "gemini-3.5-flash"}},
+		{ID: "go", Name: "Go", Key: "sk-go",
+			Chat: "https://opencode.ai/zen/go/v1", Responses: "https://opencode.ai/zen/go/v1", Anthropic: "https://opencode.ai/zen/go",
+			Models: []string{"kimi-k3", "gpt-6-luna", "minimax-m2.7"}},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	var mu sync.Mutex
+	asked := map[string][]string{}
+	s := New()
+	s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
+		b, _ := io.ReadAll(r.Body)
+		r.Body.Close()
+		model := modelOf(b)
+		if model == "" {
+			// Gemini's generateContent names the model in its path
+			if i := strings.LastIndex(r.URL.Path, "/models/"); i >= 0 {
+				model = strings.Split(r.URL.Path[i+len("/models/"):], ":")[0]
+			}
+		}
+		mu.Lock()
+		asked[model] = append(asked[model], r.URL.Host+r.URL.Path)
+		mu.Unlock()
+		return &http.Response{StatusCode: http.StatusUnauthorized, Header: http.Header{"Content-Type": {"application/json"}},
+			Body: io.NopCloser(strings.NewReader(`{"error":{"message":"Missing API key."}}`)), Request: r}, nil
+	})}
+	for _, c := range []struct{ model, path, body, want string }{ // model is the client's name; the upstream is asked the bare id
+		{"zen/kimi-k3", "/v1/chat/completions",
+			`{"model":"zen/kimi-k3","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`,
+			"opencode.ai/inference/openai/v1/chat/completions"},
+		{"zen/gpt-5.5", "/v1/responses",
+			`{"model":"zen/gpt-5.5","input":"hi","max_output_tokens":16}`,
+			"opencode.ai/inference/openai/v1/responses"},
+		{"zen/claude-sonnet-5", "/v1/messages",
+			`{"model":"zen/claude-sonnet-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`,
+			"opencode.ai/inference/anthropic/v1/messages"},
+		{"zen/gemini-3.5-flash", "/v1beta/models/zen/gemini-3.5-flash:streamGenerateContent",
+			`{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`,
+			"opencode.ai/inference/google/v1beta/models/gemini-3.5-flash:streamGenerateContent"},
+		{"go/kimi-k3", "/v1/chat/completions",
+			`{"model":"go/kimi-k3","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`,
+			"opencode.ai/inference/go/openai/v1/chat/completions"},
+		{"go/gpt-6-luna", "/v1/responses",
+			`{"model":"go/gpt-6-luna","input":"hi","max_output_tokens":16}`,
+			"opencode.ai/inference/go/openai/v1/responses"},
+		{"go/minimax-m2.7", "/v1/messages",
+			`{"model":"go/minimax-m2.7","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`,
+			"opencode.ai/inference/go/anthropic/v1/messages"},
+	} {
+		mu.Lock()
+		asked = map[string][]string{}
+		mu.Unlock()
+		req := httptest.NewRequest("POST", c.path, strings.NewReader(c.body))
+		rec := httptest.NewRecorder()
+		s.Handler().ServeHTTP(rec, req)
+		mu.Lock()
+		got := asked[strings.TrimPrefix(c.model, "zen/")]
+		got = append(got, asked[strings.TrimPrefix(c.model, "go/")]...)
+		mu.Unlock()
+		if len(got) == 0 {
+			t.Errorf("%s on %s: upstream never asked (%d %s)", c.model, c.path, rec.Code, rec.Body)
+			continue
+		}
+		if got[0] != c.want {
+			t.Errorf("%s on %s: asked %v, want %s first (%d %s)", c.model, c.path, got, c.want, rec.Code, rec.Body)
+		}
+	}
+}
+
 // The rule is OpenCode's gateway's alone: another relay saved with its
 // chat URL alone keeps it, and its models stay on it, though models.dev
 // says OpenAI's SDK serves the same model elsewhere.
diff --git a/internal/gateway/zenfree.go b/internal/gateway/zenfree.go
index efc55793a..f68b33843 100644
--- a/internal/gateway/zenfree.go
+++ b/internal/gateway/zenfree.go
@@ -13,7 +13,7 @@ import (
 // request must carry OpenCode's headers (provider.OpenCodeClient), be
 // streamed, and offer OpenCode's core tools, or Zen answers 403
 // "OpenCode's free tier can only be used from within OpenCode"; be asked
-// at OpenCode 2's paths (provider.OpenCodeFreeURL), with each core tool
+// at OpenCode 2's paths (provider.OpenCodeV2URL), with each core tool
 // taking OpenCode's parameters (provider.OpenCodeToolSchemas); and since
 // late October 2026 carry OpenCode 2's User-Agent and its environment
 // block in the system prompt (provider.OpenCodeEnvironment), or Zen
diff --git a/internal/gateway/zenfree_test.go b/internal/gateway/zenfree_test.go
index b79de9ee1..731e1401f 100644
--- a/internal/gateway/zenfree_test.go
+++ b/internal/gateway/zenfree_test.go
@@ -285,7 +285,7 @@ func TestZenFreeAtInferenceURL(t *testing.T) {
 	})}
 	zenSend(t, s, "/v1/chat/completions", `{"model":"zen/mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}]}`)
 	zenSend(t, s, "/v1/chat/completions", `{"model":"zen/kimi-k2.6","messages":[{"role":"user","content":"hi"}]}`)
-	if len(paths) != 2 || paths[0] != "opencode.ai/inference/openai/v1/chat/completions" || paths[1] != "opencode.ai/zen/v1/chat/completions" {
+	if len(paths) != 2 || paths[0] != "opencode.ai/inference/openai/v1/chat/completions" || paths[1] != "opencode.ai/inference/openai/v1/chat/completions" {
 		t.Fatalf("paths %v", paths)
 	}
 	tools, _ := sent[0]["tools"].([]any)
diff --git a/internal/provider/opencode_client.go b/internal/provider/opencode_client.go
index 3498913cd..a802e3483 100644
--- a/internal/provider/opencode_client.go
+++ b/internal/provider/opencode_client.go
@@ -203,7 +203,7 @@ func OpenCodeSession(h http.Header, u string) {
 // OpenCodeClient sets, a streamed request offering OpenCode's core tools
 // (OpenCodeTools, OpenCodeToolSchemas) with OpenCode's environment block
 // in its system prompt (OpenCodeEnvironment), at the paths OpenCode 2
-// asks (OpenCodeFreeURL), as checked against Zen in October 2026. The
+// asks (OpenCodeV2URL), as checked against Zen in October 2026. The
 // gateway asks them so whoever the client is (gateway/zenfree.go), and the
 // Test button's probe so (zenFreeProbe). A free model is one whose id ends
 // in -free, or one models.dev's opencode prices at nothing, as big-pickle,
@@ -239,16 +239,27 @@ var OpenCodeToolSchemas = map[string]string{
 	"shell": `{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false}`,
 }
 
-// OpenCodeFreeURL is where a request on proto to Zen's free tier goes,
-// given the URL it would go to at Zen (https://opencode.ai/zen/v1/…, or
-// under /zen for Messages): where OpenCode 2 sends it, the base_url
-// models.dev's v2 catalog (models.opencode.ai/experimental/v2.0/api.json,
-// which 2.2.5 reads) gives every opencode model on 2026-11-01:
-// /inference/openai/v1 for Chat and Responses, /inference/anthropic/v1 for
-// Messages. 1.x's /inference/v1, which no OpenCode 2 request goes to, is
-// moved there too. Gemini, on which Zen gives nothing free, goes under
-// /inference as before. Any other URL, Go's (/zen/go) among them, is u.
-func OpenCodeFreeURL(u string, proto Protocol) string {
+// OpenCodeV2URL is where a request on proto to OpenCode's gateway goes,
+// given the URL it would go to at Zen or Go (https://opencode.ai/zen/v1/…,
+// /zen for Messages, /zen/go/… for Go, or under the inference API's
+// /inference and /inference/go): where OpenCode 2 sends it, the base_url
+// the v2 catalog (models.opencode.ai/experimental/v2.0/api.json, which
+// 2.2.5 reads) gives every model of the gateway's providers on 2026-11-01:
+// /inference/openai/v1 for Chat and Responses and /inference/anthropic/v1
+// for Messages at Zen, /inference/google/v1beta for Gemini, and Go's under
+// /inference/go (…/openai/v1, …/anthropic/v1, …/google/v1beta) (#4740).
+// 1.x's /zen paths, paid models' among them, move there, and so does 1.x's
+// /inference/v1, which no OpenCode 2 request goes to; so do the vendor
+// paths Go's docs gave in October 2026 at /zen/go (…/openai/v1 and
+// …/anthropic, which answer 404 there today). Gemini's /v1 depth is not
+// kept: the catalog's Google route is /v1beta, and the model rides after
+// it. The free move (#3491) had taken the free models alone this far.
+// Any other URL is u: one already on a v2 path, a relay of the user's own
+// at …/inference/custom (its vendor bills it), the models list — asked at
+// the gateway's root (/zen/v1/models today, /inference/v1/models and
+// /inference/go/v1/models as the docs give; no /v1/models under the
+// protocol paths) — and System One's /systemone among them.
+func OpenCodeV2URL(u string, proto Protocol) string {
 	pu, err := url.Parse(strings.TrimSpace(u))
 	if err != nil || pu.Scheme == "" || !openCodeHost(pu.Hostname()) {
 		return u
@@ -257,17 +268,43 @@ func OpenCodeFreeURL(u string, proto Protocol) string {
 	if !ok {
 		rest, ok = strings.CutPrefix(pu.Path, "/inference")
 	}
-	under := func(dir string) bool { return rest == dir || strings.HasPrefix(rest, dir+"/") }
-	if !ok || rest != "" && rest[0] != '/' || under("/go") || under("/openai") || under("/anthropic") || under("/google") || under("/systemone") {
+	if !ok || rest != "" && rest[0] != '/' {
+		return u
+	}
+	atGo := false
+	switch {
+	case rest == "", rest == "/v1", strings.HasPrefix(rest, "/v1/"):
+	case rest == "/go", rest == "/go/v1", strings.HasPrefix(rest, "/go/v1/"):
+		atGo, rest = true, strings.TrimPrefix(rest, "/go")
+	case strings.HasPrefix(rest, "/go/"):
+		// Go's at a vendor path (/zen/go/openai/v1, the URL Go's docs
+		// gave in October 2026): the same paths live under /inference/go
+		pu.Path = "/inference" + rest
+		return pu.String()
+	default:
+		// a v2 path (/openai/v1, /anthropic/v1, /google/v1beta,
+		// /systemone), a custom relay's, or anything else of the user's
 		return u
 	}
 	switch proto {
 	case Chat, Responses:
-		pu.Path = "/inference/openai" + rest
+		if atGo {
+			pu.Path = "/inference/go/openai" + rest
+		} else {
+			pu.Path = "/inference/openai" + rest
+		}
 	case Anthropic:
-		pu.Path = "/inference/anthropic" + rest
-	default:
-		pu.Path = "/inference" + rest
+		if atGo {
+			pu.Path = "/inference/go/anthropic" + rest
+		} else {
+			pu.Path = "/inference/anthropic" + rest
+		}
+	default: // Gemini
+		if atGo {
+			pu.Path = "/inference/go/google/v1beta" + strings.TrimPrefix(rest, "/v1")
+		} else {
+			pu.Path = "/inference/google/v1beta" + strings.TrimPrefix(rest, "/v1")
+		}
 	}
 	return pu.String()
 }
diff --git a/internal/provider/opencode_session_test.go b/internal/provider/opencode_session_test.go
index cba402bbe..bd0b3f815 100644
--- a/internal/provider/opencode_session_test.go
+++ b/internal/provider/opencode_session_test.go
@@ -74,7 +74,7 @@ func TestOpenCodeSessionOnEveryCall(t *testing.T) {
 		t.Fatalf("test: %+v", rs)
 	}
 	got := asked()
-	if len(got) != 2 || got[0][0] != "/zen/go/v1/models" || got[1][0] != "/zen/go/v1/chat/completions" {
+	if len(got) != 2 || got[0][0] != "/zen/go/v1/models" || got[1][0] != "/inference/go/openai/v1/chat/completions" {
 		t.Fatalf("asked: %q", got)
 	}
 	if !strings.HasPrefix(got[0][1], "ses_") || !strings.HasPrefix(got[1][1], "ses_") || got[0][1] == got[1][1] {
diff --git a/internal/provider/opencode_zen_test.go b/internal/provider/opencode_zen_test.go
index 7b9a68e4f..9a79798bf 100644
--- a/internal/provider/opencode_zen_test.go
+++ b/internal/provider/opencode_zen_test.go
@@ -145,12 +145,15 @@ func TestZenAddKeyEmptyIsPublic(t *testing.T) {
 // models.dev's v2 catalog gives each protocol (#3491): /inference/openai/v1
 // for Chat and Responses, /inference/anthropic for Messages, from Zen's own
 // URL or 1.x's /inference/v1. Go's and other URLs are as they were.
-func TestOpenCodeFreeURL(t *testing.T) {
+func TestOpenCodeV2URL(t *testing.T) {
 	for _, c := range []struct {
 		in    string
 		proto Protocol
 		want  string
 	}{
+		// Zen, free and paid alike (#4740): 1.x's /zen paths move to the
+		// v2 catalog's, /inference/openai/v1 for Chat and Responses and
+		// /inference/anthropic/v1 for Messages
 		{"https://opencode.ai/zen/v1", Chat, "https://opencode.ai/inference/openai/v1"},
 		{"https://opencode.ai/zen/v1/", Chat, "https://opencode.ai/inference/openai/v1/"},
 		{"https://opencode.ai/zen/v1/chat/completions", Chat, "https://opencode.ai/inference/openai/v1/chat/completions"},
@@ -162,14 +165,34 @@ func TestOpenCodeFreeURL(t *testing.T) {
 		{"https://opencode.ai/zen/v1/messages", Anthropic, "https://opencode.ai/inference/anthropic/v1/messages"},
 		{"https://opencode.ai/inference", Anthropic, "https://opencode.ai/inference/anthropic"},
 		{"https://opencode.ai/inference/anthropic/v1", Anthropic, "https://opencode.ai/inference/anthropic/v1"},
-		{"https://opencode.ai/zen/v1", Gemini, "https://opencode.ai/inference/v1"},
+		// Gemini on the Google route the catalog names it
+		{"https://opencode.ai/zen/v1", Gemini, "https://opencode.ai/inference/google/v1beta"},
+		{"https://opencode.ai/zen/v1/models/gemini-3.5-flash:generateContent", Gemini, "https://opencode.ai/inference/google/v1beta/models/gemini-3.5-flash:generateContent"},
+		{"https://opencode.ai/inference/google/v1beta", Gemini, "https://opencode.ai/inference/google/v1beta"},
+		// Go: its 1.x /zen/go paths move to the inference API's /inference/go
+		{"https://opencode.ai/zen/go/v1", Chat, "https://opencode.ai/inference/go/openai/v1"},
+		{"https://opencode.ai/zen/go/v1/chat/completions", Chat, "https://opencode.ai/inference/go/openai/v1/chat/completions"},
+		{"https://opencode.ai/zen/go/v1/responses", Responses, "https://opencode.ai/inference/go/openai/v1/responses"},
+		{"https://opencode.ai/zen/go", Anthropic, "https://opencode.ai/inference/go/anthropic"},
+		{"https://opencode.ai/zen/go/v1/messages", Anthropic, "https://opencode.ai/inference/go/anthropic/v1/messages"},
+		{"https://opencode.ai/inference/go/v1", Chat, "https://opencode.ai/inference/go/openai/v1"},
+		{"https://opencode.ai/inference/go/v1", Gemini, "https://opencode.ai/inference/go/google/v1beta"},
+		{"https://opencode.ai/inference/go/openai/v1", Chat, "https://opencode.ai/inference/go/openai/v1"},
+		{"https://opencode.ai/inference/go/anthropic/v1", Anthropic, "https://opencode.ai/inference/go/anthropic/v1"},
+		// the vendor paths Go's docs gave in October 2026, dead at /zen/go
+		// today, move to the inference API's, where the catalog puts them
+		{"https://opencode.ai/zen/go/openai/v1", Chat, "https://opencode.ai/inference/go/openai/v1"},
+		{"https://opencode.ai/zen/go/anthropic/v1/messages", Anthropic, "https://opencode.ai/inference/go/anthropic/v1/messages"},
+		// untouched: a relay of the user's own at …/inference/custom, and
+		// anything not at the gateway's own depths (the models list is
+		// asked at the root's /v1/models, System One at /systemone —
+		// neither goes through here)
+		{"https://opencode.ai/inference/custom/relay/v1", Chat, "https://opencode.ai/inference/custom/relay/v1"},
 		{"https://opencode.ai/zenith/v1", Chat, "https://opencode.ai/zenith/v1"},
-		{"https://opencode.ai/zen/go/v1", Chat, "https://opencode.ai/zen/go/v1"},
-		{"https://opencode.ai/zen/go", Anthropic, "https://opencode.ai/zen/go"},
 		{"https://relay.test/zen/v1", Chat, "https://relay.test/zen/v1"},
 		{"https://api.opencode.ai/zen/v1", Chat, "https://api.opencode.ai/inference/openai/v1"},
 	} {
-		if got := OpenCodeFreeURL(c.in, c.proto); got != c.want {
+		if got := OpenCodeV2URL(c.in, c.proto); got != c.want {
 			t.Errorf("%s on %s: %s, want %s", c.in, c.proto, got, c.want)
 		}
 	}
@@ -180,9 +203,21 @@ func TestOpenCodeFreeURL(t *testing.T) {
 	if url, _ := tiny(p, Anthropic, "claude-free"); url != "https://opencode.ai/inference/anthropic/v1/messages" {
 		t.Fatalf("Messages probe %s", url)
 	}
-	if url, _ := tiny(p, Responses, "gpt-5.5"); url != "https://opencode.ai/zen/v1/responses" {
+	// paid, Zen: the same paths, asked with a key (#4740)
+	if url, _ := tiny(p, Responses, "gpt-5.5"); url != "https://opencode.ai/inference/openai/v1/responses" {
 		t.Fatalf("paid probe %s", url)
 	}
+	if url, _ := tiny(p, Anthropic, "claude-sonnet-5"); url != "https://opencode.ai/inference/anthropic/v1/messages" {
+		t.Fatalf("paid Messages probe %s", url)
+	}
+	// paid, Go
+	g, _ := FromPreset("opencode-go")
+	if url, _ := tiny(g, Chat, "kimi-k3"); url != "https://opencode.ai/inference/go/openai/v1/chat/completions" {
+		t.Fatalf("Go paid probe %s", url)
+	}
+	if url, _ := tiny(g, Anthropic, "minimax-m3"); url != "https://opencode.ai/inference/go/anthropic/v1/messages" {
+		t.Fatalf("Go paid Messages probe %s", url)
+	}
 }
 
 // zenFake serves Zen's /models as the public key read it on 2026-10-15
diff --git a/internal/provider/test.go b/internal/provider/test.go
index a29178747..b68389c07 100644
--- a/internal/provider/test.go
+++ b/internal/provider/test.go
@@ -116,8 +116,12 @@ func tiny(q Provider, proto Protocol, model string) (url, body string) {
 	if q.Account != nil && q.Account.Stream && body != "" {
 		body = strings.TrimSuffix(body, "}") + `,"stream":true}`
 	}
+	if q.IsOpenCode() {
+		// on the paths OpenCode 2 reads the model on, paid ones' too (#4740)
+		url = OpenCodeV2URL(url, proto)
+	}
 	if q.OpenCodeFree(model) && body != "" {
-		url, body = OpenCodeFreeURL(url, proto), zenFreeProbe(proto, body)
+		body = zenFreeProbe(proto, body)
 	}
 	if q.IsCline() && body != "" {
 		body = clineProbe(body)
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4740-paid-zen-v2-paths](https://github.com/ggbdpq/magpie/tree/fix/4740-paid-zen-v2-paths) (head `735b4ca9769f62d3846e88dfd9f002f3233b2322`).

