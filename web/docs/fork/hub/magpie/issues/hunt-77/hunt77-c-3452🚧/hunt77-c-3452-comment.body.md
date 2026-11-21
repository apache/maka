Summary

A provider pointed at llama.cpp's llama-server lists its model with neither the window nor the input the server serves it with: llama-server's `/v1/models` tells them in `meta.n_ctx` and `architecture.input_modalities`, and the list magpie reads looked at `context_length` and `modalities.input` only. The Ollama routes' `/api/show` then answered the stand-in window (32768) and no vision, and a client reading `/api/show` — Hermes Agent, for one — refused to run a model the server serves with 131072 and images.

What changed

- `fetchPage` (`internal/catalog/live.go`) reads `meta.n_ctx` for the window where the list tells no `context_length` — the list's own stays first where it has one — and `architecture.input_modalities` for the input where it tells no `modalities.input`. Both by the field's being there, not by who the vendor is.
- A model not loaded yet (router mode, `--models-dir`) has no `meta` and a text-only architecture: it stays exactly as it was — window 0, the stand-in answering `/api/show`, text only.
- An odd `meta` or `architecture`, or a zero `n_ctx`, loses itself and not the whole list — the rule the list's other freely-typed fields already follow; both are read as `json.RawMessage` and unmarshalled beside the list, so a strange value cannot fail the read.
- Sibling surfaces, checked and left alone: the entry's `InputModalities`/`OutputModalities` stay unset for these lists, so an agent's model list keeps deriving from the image answer ("text, image") and takes no stray "video" in; the 32768 stand-in keeps its meaning (a window magpie doesn't know, told so a client never reads 0); Ollama's own served lists carry neither field and read as they did. No llama.cpp preset is added — the reporter's "Also" is a feature of its own, kept out of scope.

Verification
| Check | Result |
| --- | --- |
| `TestFetchLlamacppWindow` (catalog) | pass — red on the base: `gemma-4-qat: 0 <nil>` |
| `TestOllamaShowTellsALlamacppWindow` (gateway, `/api/show` end to end) | pass — red on the base: window 32768, capabilities `[completion tools]` |
| Ablation (product file reverted to the base, tests kept) | both red as above; restored, both green |
| `TestFetchContextLength`, `TestFetchMagpieFields`, `TestOllamaModelRoutes` | pass (guards: the lists told before, and the 32768 stand-in) |
| `go test -tags nogui ./internal/catalog/ ./internal/gateway/ -count=1` | ok (gateway 363s) |
| `gofmt -l internal/catalog internal/gateway` | clean |
| `go vet ./...` | exit 0 (one pre-existing cgo `-Wenum-conversion` warning in `internal/gui/trayimage_darwin.go`, untouched) |
| `GOOS=linux go vet -tags nogui ./...` / `GOOS=windows go vet ./...` | both exit 0 |
| `go build -tags nogui ./...` on darwin / linux / windows | all ok |
| A real llama-server | not run — the reporter's JSON shape, served by httptest, stands in |

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
<details><summary>patch: hunt77-c-3452 (#3452) — git am applies it as is; SHA-256 first 16: 009327257a050b34</summary>

```text
From 0042680c7b82e77900f33cda23f5e52f14983db9 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 15:01:17 +0800
Subject: [PATCH] catalog: a llama-server's model list is read for its window
 and its input modalities, told where an OpenAI-shaped list's would not be
 (#3452)

What changed
- llama.cpp's llama-server answers /v1/models with each model's window
  per slot in meta.n_ctx and its input modalities in
  architecture.input_modalities, where a list's context_length and
  modalities.input would be; a provider pointed at one listed its model
  with neither, so the Ollama routes' /api/show told the stand-in window
  (32768) and no vision, and a client reading /api/show (Hermes Agent)
  refused to run a model the server serves with 131072 and images.
- fetchPage now reads meta.n_ctx for the window where the list tells no
  context_length (the list's own stays first), and
  architecture.input_modalities for the input where it tells no
  modalities.input. Both by the field's being there, not by who the
  vendor is; a model not loaded yet (router mode) has no meta and a
  text-only architecture and stays as it was, and an odd meta or
  architecture loses itself, not the whole list.
- No llama.cpp preset is added; the reporter's "Also" is a feature of
  its own.

Run
- TestFetchLlamacppWindow (catalog) and
  TestOllamaShowTellsALlamacppWindow (gateway) fail on the old code
  (window 0/32768, no vision) and pass with the change;
  TestFetchContextLength, TestFetchMagpieFields and TestOllamaModelRoutes
  keep the vendors told before reading it as they were.
- go test -tags nogui ./internal/catalog/ ./internal/gateway/, gofmt -l,
  go vet ./..., GOOS=linux go vet -tags nogui ./..., GOOS=windows go vet
  ./... and the three platforms' go build pass.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/catalog/live.go        | 42 ++++++++++++++++++++++++-
 internal/catalog/live_test.go   | 56 +++++++++++++++++++++++++++++++++
 internal/gateway/ollama_test.go | 46 +++++++++++++++++++++++++++
 3 files changed, 143 insertions(+), 1 deletion(-)

diff --git a/internal/catalog/live.go b/internal/catalog/live.go
index cc8671cb..275beb78 100644
--- a/internal/catalog/live.go
+++ b/internal/catalog/live.go
@@ -601,7 +601,11 @@ func fetchPage(ctx context.Context, url, key string, anthropic bool, headers map
 		if name == "" {
 			name = id
 		}
-		input := imageInput(r.Modalities.Input)
+		in := r.Modalities.Input
+		if len(in) == 0 {
+			in = llamacppInputs(r.Architecture)
+		}
+		input := imageInput(in)
 		apis := EndpointAPIs(r.Endpoints)
 		if native := EndpointAPIs(r.Native); len(native) > 0 {
 			apis = native
@@ -613,6 +617,8 @@ func fetchPage(ctx context.Context, url, key string, anthropic bool, headers map
 			InputModalities: r.Modalities.Input, OutputModalities: r.Modalities.Output}
 		if n, ok := r.ContextLength.(float64); ok && n > 0 {
 			m.Context = int(n)
+		} else if n, ok := llamacppNCtx(r.Meta); ok && n > 0 {
+			m.Context = int(n)
 		}
 		if n, ok := r.Output.(float64); ok && n > 0 {
 			m.Output = int(n)
@@ -634,6 +640,34 @@ func fetchPage(ctx context.Context, url, key string, anthropic bool, headers map
 	return out, v.HasMore, v.LastID, nil
 }
 
+// llamacppNCtx is the window a llama-server's list tells in meta.n_ctx,
+// whether the entry has one: the window per slot the server was started
+// with (-c), where a list's context_length would be. One not told, or not
+// a number, is no window.
+func llamacppNCtx(meta json.RawMessage) (float64, bool) {
+	var m struct {
+		NCtx any `json:"n_ctx"`
+	}
+	if len(meta) == 0 || json.Unmarshal(meta, &m) != nil {
+		return 0, false
+	}
+	n, ok := m.NCtx.(float64)
+	return n, ok
+}
+
+// llamacppInputs is the input modalities a llama-server's list tells in
+// architecture.input_modalities, where a list's modalities.input would
+// be; none told, or oddly, is none.
+func llamacppInputs(architecture json.RawMessage) []string {
+	var a struct {
+		InputModalities []string `json:"input_modalities"`
+	}
+	if len(architecture) == 0 || json.Unmarshal(architecture, &a) != nil {
+		return nil
+	}
+	return a.InputModalities
+}
+
 // errorMessage is the message of a vendor's JSON error reply
 // ({"error":{"message":…}}, {"error":"…"}, {"message":…}), cut short.
 func errorMessage(b []byte) string {
@@ -669,6 +703,12 @@ type liveModel struct {
 		Input  []string `json:"input"`
 		Output []string `json:"output"`
 	} `json:"modalities"`
+	// llama.cpp's llama-server tells the window per slot in meta.n_ctx
+	// and the input modalities in architecture.input_modalities, where a
+	// list's context_length and modalities.input would be (#3452). Raw,
+	// as a vendor's odd value mustn't lose the whole list
+	Meta         json.RawMessage `json:"meta"`
+	Architecture json.RawMessage `json:"architecture"`
 	// the paths the model is served on, where the vendor says: Command
 	// Code's Claude models on /messages alone, its open ones on
 	// /chat/completions and /responses
diff --git a/internal/catalog/live_test.go b/internal/catalog/live_test.go
index f8198be1..d0a1af68 100644
--- a/internal/catalog/live_test.go
+++ b/internal/catalog/live_test.go
@@ -47,6 +47,62 @@ func TestFetchContextLength(t *testing.T) {
 	}
 }
 
+// A llama-server's list tells each model's window per slot in meta.n_ctx
+// and its input modalities in architecture.input_modalities, where a
+// list's context_length and modalities.input would be (#3452): a server
+// started with -c 131072 --mmproj lists the model with the window it
+// serves and the image it takes, where magpie read neither and its
+// /api/show told the stand-in window and no vision. A model not loaded
+// yet (router mode) has no meta and a text-only architecture, a list's
+// own context_length stays first where it has one, and a vendor's odd
+// value loses neither the field nor the whole list.
+func TestFetchLlamacppWindow(t *testing.T) {
+	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
+		rw.Write([]byte(`{"object":"list","data":[
+		  {"id":"gemma-4-qat","owned_by":"llamacpp","architecture":{"input_modalities":["text","image","video"],"output_modalities":["text"]},"meta":{"n_ctx":131072,"n_ctx_train":262144}},
+		  {"id":"gemma-4-unloaded","owned_by":"llamacpp","architecture":{"input_modalities":["text"],"output_modalities":["text"]}},
+		  {"id":"claude-sonnet-5","context_length":1000000,"meta":{"n_ctx":1}},
+		  {"id":"zero","meta":{"n_ctx":0}},
+		  {"id":"odd","meta":"llamacpp","architecture":"gemma"}]}`))
+	}))
+	defer srv.Close()
+	ms, _, err := FetchAt(context.Background(), srv.URL+"/v1", "k", false, nil)
+	if err != nil {
+		t.Fatal(err)
+	}
+	type seen struct {
+		context int
+		images  *bool
+	}
+	got := map[string]seen{}
+	for _, m := range ms {
+		got[m.ID] = seen{m.Context, m.ImageInput}
+	}
+	qat := got["gemma-4-qat"]
+	if qat.context != 131072 || qat.images == nil || !*qat.images {
+		t.Errorf("gemma-4-qat: %d %v", qat.context, qat.images)
+	}
+	// not loaded yet: no window of its own (the stand-in answers /api/show
+	// as before) and text only, as the list says
+	unloaded := got["gemma-4-unloaded"]
+	if unloaded.context != 0 || unloaded.images == nil || *unloaded.images {
+		t.Errorf("gemma-4-unloaded: %d %v", unloaded.context, unloaded.images)
+	}
+	// a list's own context_length is the window it is, whatever meta adds
+	if got["claude-sonnet-5"].context != 1000000 {
+		t.Errorf("claude-sonnet-5: %d", got["claude-sonnet-5"].context)
+	}
+	if got["zero"].context != 0 {
+		t.Errorf("zero: %d", got["zero"].context)
+	}
+	// an odd meta or architecture loses itself, not the whole list; a
+	// model neither of them says anything of is left as it was
+	odd := got["odd"]
+	if odd.context != 0 || odd.images != nil || len(got) != 5 {
+		t.Errorf("odd: %+v of %v", odd, got)
+	}
+}
+
 // Another magpie's list tells each model's native APIs, over the ones it
 // serves it on, its longest reply and its reasoning levels; a vendor's odd
 // values are only left out, never the whole list.
diff --git a/internal/gateway/ollama_test.go b/internal/gateway/ollama_test.go
index 33ef234f..52c8c5f3 100644
--- a/internal/gateway/ollama_test.go
+++ b/internal/gateway/ollama_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"context"
 	"encoding/json"
 	"fmt"
 	"io"
@@ -127,6 +128,51 @@ func TestOllamaModelRoutes(t *testing.T) {
 	}
 }
 
+// A provider pointed at llama.cpp's llama-server: its /v1/models says each
+// model's window in meta.n_ctx and its input modalities in
+// architecture.input_modalities (#3452), so /api/show tells the window the
+// server was started with (-c 131072) and vision, where it told the
+// stand-in 32768 and no vision and a client reading /api/show refused to
+// run the model for a window it does serve.
+func TestOllamaShowTellsALlamacppWindow(t *testing.T) {
+	fresh(t)
+	up := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
+		io.WriteString(rw, `{"object":"list","data":[{"id":"gemma-4-qat","owned_by":"llamacpp","architecture":{"input_modalities":["text","image","video"],"output_modalities":["text"]},"meta":{"n_ctx":131072,"n_ctx_train":262144}}]}`)
+	}))
+	defer up.Close()
+	if err := provider.Save(provider.Provider{ID: "llamacpp", Name: "LlamaCpp", Key: "k", Chat: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	p, err := provider.Find("llamacpp")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, err := p.Fetch(context.Background()); err != nil {
+		t.Fatal(err)
+	}
+	h := New().Handler()
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/api/show", strings.NewReader(`{"model":"llamacpp/gemma-4-qat"}`))
+	req.RemoteAddr = "127.0.0.1:50123"
+	h.ServeHTTP(rec, req)
+	if rec.Code != 200 {
+		t.Fatalf("show: %d %s", rec.Code, rec.Body)
+	}
+	var s struct {
+		Capabilities []string
+		ModelInfo    map[string]any `json:"model_info"`
+	}
+	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
+		t.Fatal(rec.Body.String())
+	}
+	if s.ModelInfo["magpie.context_length"] != float64(131072) {
+		t.Errorf("model_info window: %v", s.ModelInfo["magpie.context_length"])
+	}
+	if !slices.Contains(s.Capabilities, "vision") {
+		t.Errorf("capabilities %v", s.Capabilities)
+	}
+}
+
 // A gateway key held to some models is listed and shown those alone on the
 // Ollama routes, as on /v1/models, and chats on /api/chat and
 // /api/generate with those alone, as on /v1/chat/completions.
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt77-c-llamacpp-window](https://github.com/ggbdpq/magpie/tree/hunt77-c-llamacpp-window) (head `0042680c7b82e77900f33cda23f5e52f14983db9`).
