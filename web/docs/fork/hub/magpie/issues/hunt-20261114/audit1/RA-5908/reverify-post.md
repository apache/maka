Re-verified at current main (`eb1b83000`): both commits of the series rebased and every element below re-ran on that tip.

| Element | Status / evidence at `eb1b83000` |
| --- | --- |
| Rebase | both commits clean, range-diff `=` on each — zero semantic drift |
| git am | both patches below apply in order to a clean `eb1b83000` tree; result tree-identical to the branch (`8b22445ee3`) |
| Tests | full `internal/agent` package: only `TestMothX` fails — red on the untouched tip too (re-run alone: same red), the pre-existing red on record, not this series; full `internal/gateway` package ok (1396.6s — holds the parallel-calls wire fixtures the first commit added); all 12 `TestAntigravity*` ok, and ok under `-race`; the wire fixtures in gateway ok; gofmt/vet clean; nogui build ok for linux/darwin/windows |
| Ablation (red without the fix) | cut 1 — `antigravity.go` reverted to the tip's (both commits undone), tests kept: `TestAntigravityGateway`/`TestAntigravityEffort`/`TestAntigravityConfigJSON`/`TestAntigravitySyncWiresConfigJSON`/`TestAntigravityWireProtocolKept` all FAIL (`a block magpie starts writes "openai", want genai` among them); cut 2 — only the second commit's `antigravity.go` reverted (keep-only state): the same five FAIL, the genai default gone; each restored, green |
| Siblings | `wireProtocol` at this tip is written only in `antigravityGateway` (the same single writer); nothing else reads the value; the single-wire blocks (avibe, miniq, fx, qoder) stand as the post below left them |
| Field evidence | carried from the post below: the reporter's on-device A/B (same provider, same model, only `wireProtocol` flipped — retries for good on `openai`, finishes on `genai`) remains the only device data and is what convicts `openai`; a real Antigravity app is NOT-RUNNABLE here, GUI too |

New branch head: `80d943a47ccb21f9` — branch: https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5908
Patches below rebuilt at the new heads — SHA-256 first 16: keep `46bf961e1789f2cf`, genai default `c1dbfcd4ecfa1627`

**Not verified** (carried over): a real Antigravity app (the reporter's on-device A/B is the only device data, and it is what convicts `openai`; NOT-RUNNABLE here), GUI.

**Attribution**: AI-written (this re-verification comment, written with GLM-5.3-Flash (ZCode)); I've read the whole diff. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Patch 1 of 2 (the keep, Nov 10's patch rebased): <details><summary>patch: agent: Antigravity's wire protocol stays what the file holds (#5908) — git am applies it as is; SHA-256 first 16: 46bf961e1789f2cf</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 10 Nov 2026 22:39:06 +0800
Subject: [PATCH 1/2] agent: Antigravity's wire protocol stays what the file
 holds (#5908)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

On a gateway, Antigravity's app talks to magpie on the wire protocol
its config names, and magpie wrote openai there every time it synced
or re-connected the file. On that openai stream the app's own
accumulator folds a turn's parallel calls into one — the ids, names
and arguments of the model's functionCalls collapsing into a single
call — so its turns retry for good over a Gemini-compatible provider
(#5908); on genai it reads the same calls whole, one part each, and
the reporter's own way out was hand-setting genai, which magpie's
next write put back on openai. mergeTheirs keeps a key magpie doesn't
write; wireProtocol is one it does, so the file's own value never
survived.

So a wired file's wireProtocol stays what the file holds: the
reporter's genai keeps working past magpie's syncs, and any other
value the app reads is the user's to pick. A block magpie starts (no
gateway of its own in the file yet) still says openai, as does a file
that names none. magpie's address, key and catalog still refresh; a
user's added keys stay, as theirsKept already kept them. magpie
serves both wires on the same address (the app asks /v1/chat/
completions on openai, /v1beta/models/{model}:streamGenerateContent
on genai), so nothing else reads the value.

Run:
- TestAntigravityWireProtocolKept: a fresh block writes openai; a
  hand-set genai survives a re-connect and a sync, with magpie's url
  and key still in place (red on the old code: genai written back to
  openai — the report's own workaround, undone at the next sync).
- TestAntigravityGateway: a user's own genai gateway is stashed and
  replaced with magpie's openai block, as before.
- TestAntigravitySyncWiresConfigJSON and the 2.30-file, legacy-file,
  admin and env batches — green.
- The parallel calls themselves measured on both wires end to end, a
  Gemini-compatible fake upstream answering three functionCalls (one
  chunk, one call a chunk, upstream ids, thought signatures, thinking
  between the calls, a whole reply): the openai wire carries three
  tool_calls at indexes 0,1,2 with an id of their own each and the
  replayed history keeps every call and every answer; the genai wire
  carries three whole functionCalls. All green on this base
  (TestChatWireKeepsParallelCallsApart, TestChatWireReplaysParallel-
  CallsWhole, TestChatWireParallelCallShapes, TestChatWireParallel-
  CallsWholeReply, TestGenaiWireParallelCalls) — the fold lives in
  the app's openai accumulator, which magpie's frames meet with the
  shape OpenAI itself streams.
- go test -tags nogui ./internal/agent (whole package): green but
  TestMothX, red on the parent commit too on this machine.
- The named tests again with -race: green. gofmt -l empty.
- Ablation: the keep branch made a no-op turns
  TestAntigravityWireProtocolKept red; restored, green.
- Sibling scan: wireProtocol is written nowhere else; nothing else
  reads it; avibe, miniq, fx and qoder name a protocol in blocks
  magpie writes for apps with a single wire against magpie, where no
  user choice and no defect is on record — left as they are;
  theirsKept and mergeTheirs untouched.

Not tried: a real Antigravity app (none on this machine); the wire
fixtures pin the frames the report's chain carries.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/antigravity.go                 |  23 +-
 internal/agent/antigravity_test.go            |  35 ++
 .../gateway/chat_parallel_calls_wire_test.go  | 316 ++++++++++++++++++
 3 files changed, 369 insertions(+), 5 deletions(-)
 create mode 100644 internal/gateway/chat_parallel_calls_wire_test.go

diff --git a/internal/agent/antigravity.go b/internal/agent/antigravity.go
index e9921672b..463e8834b 100644
--- a/internal/agent/antigravity.go
+++ b/internal/agent/antigravity.go
@@ -122,8 +122,21 @@ func (f agyFile) wired() bool {
 	return on == "true" && gatewayKey(key)
 }
 
-func antigravityGateway() map[string]any {
-	return map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}
+// antigravityGateway is the gateway block magpie writes at path. The wire
+// protocol stays the file's once it holds one: on the app's openai stream
+// its own accumulator folds a turn's parallel calls into one, their ids,
+// names and arguments lost (#5908), and on genai it reads them whole, so
+// the protocol of a wired file is the user's to pick (a Gemini-native
+// provider's row wants genai). A file with none is put on openai, as
+// before, and so is a block magpie starts.
+func antigravityGateway(path string) map[string]any {
+	proto := "openai"
+	if path != "" {
+		if v, _ := edit.GetJSON(path, "gateway.wireProtocol"); strings.TrimSpace(v) != "" {
+			proto = v
+		}
+	}
+	return map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": proto}
 }
 
 // keepSource stashes a catalog of the user's that a file wired before
@@ -186,10 +199,10 @@ func (f agyFile) connect(ref string) error {
 		return err
 	}
 	// set again on magpie, what the user added to its block stays
-	block := any(antigravityGateway())
+	block := any(antigravityGateway(""))
 	if on {
 		f.keepSource()
-		block = theirsKept(f.path, "gateway", func() any { return antigravityGateway() })()
+		block = theirsKept(f.path, "gateway", func() any { return antigravityGateway(f.path) })()
 	}
 	kv := []edit.KV{{Path: "gateway", Value: block}, {Path: antigravitySource, Value: antigravityCatalog()}}
 	if ref != "" {
@@ -241,7 +254,7 @@ func (f agyFile) leave(v string, always bool) error {
 // sync brings a wired file's gateway and catalog to the gateway's current
 // address, and the model it starts on to a level the catalog lists
 func (f agyFile) sync() error {
-	if err := syncJSON(f.path, "gateway", theirsKept(f.path, "gateway", func() any { return antigravityGateway() })); err != nil {
+	if err := syncJSON(f.path, "gateway", theirsKept(f.path, "gateway", func() any { return antigravityGateway(f.path) })); err != nil {
 		return err
 	}
 	// the catalog at the gateway's address, and on a file wired before
diff --git a/internal/agent/antigravity_test.go b/internal/agent/antigravity_test.go
index 35d98744c..124b63808 100644
--- a/internal/agent/antigravity_test.go
+++ b/internal/agent/antigravity_test.go
@@ -560,3 +560,38 @@ func TestAntigravitySyncWiresConfigJSON(t *testing.T) {
 		t.Errorf("settings.json:\n%s", readFile(legacy))
 	}
 }
+
+// The wire protocol of a file on magpie stays what the file holds: on the
+// app's openai stream its own accumulator folds a turn's parallel calls
+// into one (id, names and arguments lost, #5908), and on genai it reads
+// them whole, so the protocol is the user's to pick once magpie wired the
+// file (the reporter hand-set genai and had it work until magpie's next
+// write put openai back). What magpie writes still refreshes; a file with
+// no wire protocol of its own is put on openai, as before.
+func TestAntigravityWireProtocolKept(t *testing.T) {
+	home := antigravityHome(t)
+	path := filepath.Join(home, ".antigravity", "settings.json")
+	os.MkdirAll(filepath.Dir(path), 0o755)
+	a := antigravity(home)
+	f := a.Field("model")
+	if err := f.Set("magpie/anth/claude-sonnet-5"); err != nil {
+		t.Fatal(err)
+	}
+	if got, _ := edit.GetJSON(path, "gateway.wireProtocol"); got != "openai" {
+		t.Fatalf("a block magpie starts writes %q, want openai", got)
+	}
+	// the reporter's pick, hand-set in magpie's own block
+	if err := edit.SetJSON(path, edit.KV{Path: "gateway.wireProtocol", Value: "genai"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := f.Set("magpie/anth/claude-sonnet-5"); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "genai"}
+	if file := antigravityFile(t, path); !sameJSON(string(file["gateway"]), want) {
+		t.Fatalf("the wire protocol didn't stay the user's: %s", readFile(path))
+	}
+}
diff --git a/internal/gateway/chat_parallel_calls_wire_test.go b/internal/gateway/chat_parallel_calls_wire_test.go
new file mode 100644
index 000000000..7e1c522de
--- /dev/null
+++ b/internal/gateway/chat_parallel_calls_wire_test.go
@@ -0,0 +1,316 @@
+package gateway
+
+import (
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/tidwall/gjson"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// Antigravity's app, wired with wireProtocol "openai", asks
+// /v1/chat/completions streamed (#5908). The model's parallel calls —
+// three functionCall parts in one turn from a custom Gemini-compatible
+// provider — have to reach it as three tool_calls its OpenAI-style SDK
+// keeps apart: an index and an id of their own each, so it runs all three
+// and answers each by id. Merged into one, the turn's correspondence of
+// ids, arguments and results is lost and the app retries for good.
+
+// chatParallelUpstream is a Gemini API whose model answers a prompt for
+// parallel calls with three functionCall parts in one chunk.
+func chatParallelUpstream(t *testing.T) (*httptest.Server, func() []string) {
+	t.Helper()
+	var mu sync.Mutex
+	var bodies []string
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		b, _ := io.ReadAll(r.Body)
+		if !strings.HasSuffix(r.URL.Path, ":streamGenerateContent") {
+			http.NotFound(w, r)
+			return
+		}
+		mu.Lock()
+		bodies = append(bodies, string(b))
+		mu.Unlock()
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}},{"functionCall":{"name":"read_file","args":{"path":"b"}}},{"functionCall":{"name":"read_file","args":{"path":"c"}}}]}}],"modelVersion":"gemini-4-argon"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}`,
+		))
+	}))
+	t.Cleanup(up.Close)
+	return up, func() []string {
+		mu.Lock()
+		defer mu.Unlock()
+		return append([]string(nil), bodies...)
+	}
+}
+
+// streamedToolCalls collects the tool_calls deltas of a Chat Completions
+// SSE reply: the fragments per index, and the finish reason.
+func streamedToolCalls(t *testing.T, body string) (map[string]string, map[string]string, string) {
+	t.Helper()
+	args := map[string]string{} // index -> arguments as they add up
+	ids := map[string]string{}  // index -> id
+	finish := ""
+	for _, line := range strings.Split(body, "\n") {
+		line = strings.TrimSpace(line)
+		if !strings.HasPrefix(line, "data: ") {
+			continue
+		}
+		data := strings.TrimPrefix(line, "data: ")
+		if data == "[DONE]" {
+			continue
+		}
+		if !gjson.Get(data, "choices").Exists() {
+			continue
+		}
+		if f := gjson.Get(data, "choices.0.finish_reason"); f.Exists() && f.Type == gjson.String && f.String() != "" {
+			finish = f.String()
+		}
+		for _, tc := range gjson.Get(data, "choices.0.delta.tool_calls").Array() {
+			idx := tc.Get("index").String()
+			if id := tc.Get("id"); id.Exists() && id.String() != "" {
+				ids[idx] = id.String()
+			}
+			args[idx] += tc.Get("function.arguments").String()
+		}
+	}
+	return ids, args, finish
+}
+
+func TestChatWireKeepsParallelCallsApart(t *testing.T) {
+	up, _ := chatParallelUpstream(t)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "gem", Name: "Gem", Key: "AIza-test", Gemini: up.URL + "/v1beta", Models: []string{"gemini-4-argon"}}); err != nil {
+		t.Fatal(err)
+	}
+	gw := httptest.NewServer(New().Handler())
+	defer gw.Close()
+	res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(
+		`{"model":"gem/gemini-4-argon","stream":true,"messages":[{"role":"user","content":"call three tools in parallel"}],
+		  "tools":[{"type":"function","function":{"name":"read_file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if res.StatusCode != 200 {
+		t.Fatalf("status %d: %s", res.StatusCode, b)
+	}
+	ids, args, finish := streamedToolCalls(t, string(b))
+	if len(ids) != 3 {
+		t.Fatalf("the reply carried %d calls, want 3: %s", len(ids), b)
+	}
+	want := map[string]string{"0": `{"path":"a"}`, "1": `{"path":"b"}`, "2": `{"path":"c"}`}
+	seen := map[string]bool{}
+	for idx, w := range want {
+		if ids[idx] == "" {
+			t.Fatalf("no call at index %s: %s", idx, b)
+		}
+		if seen[ids[idx]] {
+			t.Fatalf("two calls share id %s: %s", ids[idx], b)
+		}
+		seen[ids[idx]] = true
+		if strings.Join(strings.Fields(args[idx]), "") != w {
+			t.Fatalf("call %s arguments %q, want %s: %s", idx, args[idx], w, b)
+		}
+	}
+	if finish != "tool_calls" {
+		t.Fatalf("finish_reason %q, want tool_calls: %s", finish, b)
+	}
+}
+
+// The turn after the calls: the app answers each by its id, and the
+// history it replays — the assistant turn with all three tool_calls and
+// the three answers — reaches the Gemini upstream with every call and
+// every response, each paired by id.
+func TestChatWireReplaysParallelCallsWhole(t *testing.T) {
+	up, bodies := chatParallelUpstream(t)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "gem", Name: "Gem", Key: "AIza-test", Gemini: up.URL + "/v1beta", Models: []string{"gemini-4-argon"}}); err != nil {
+		t.Fatal(err)
+	}
+	gw := httptest.NewServer(New().Handler())
+	defer gw.Close()
+	res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(
+		`{"model":"gem/gemini-4-argon","stream":true,"messages":[
+			{"role":"user","content":"call three tools in parallel"},
+			{"role":"assistant","content":null,"tool_calls":[
+				{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}},
+				{"id":"call_2","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"b\"}"}},
+				{"id":"call_3","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"c\"}"}}]},
+			{"role":"tool","tool_call_id":"call_1","content":"a-file"},
+			{"role":"tool","tool_call_id":"call_2","content":"b-file"},
+			{"role":"tool","tool_call_id":"call_3","content":"c-file"}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if res.StatusCode != 200 {
+		t.Fatalf("status %d: %s", res.StatusCode, b)
+	}
+	bs := bodies()
+	if len(bs) != 1 {
+		t.Fatalf("upstream asked %d times: %s", len(bs), b)
+	}
+	raw := gjson.Get(bs[0], "contents").Raw
+	for _, s := range []string{`"path":"a"`, `"path":"b"`, `"path":"c"`, "a-file", "b-file", "c-file"} {
+		if !strings.Contains(raw, s) {
+			t.Fatalf("upstream history lost %s: %s", s, raw)
+		}
+	}
+	calls := gjson.Get(bs[0], "contents.#(role==model).parts")
+	n := 0
+	for _, p := range calls.Array() {
+		if p.Get("functionCall").Exists() {
+			n++
+		}
+	}
+	if n != 3 {
+		t.Fatalf("the call turn holds %d functionCalls, want 3: %s", n, raw)
+	}
+}
+
+// The same turn in the shapes a Gemini-compatible provider streams it:
+// one call a chunk, ids of the upstream's own, a thought signature riding
+// each call, thinking between the calls — and the reply asked whole. All
+// of them reach the app as three calls kept apart.
+func TestChatWireParallelCallShapes(t *testing.T) {
+	cases := []struct {
+		name   string
+		frames []string
+	}{
+		{"one call a chunk", []string{
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"b"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"c"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}`,
+		}},
+		{"ids of the upstream's own", []string{
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc_1","name":"read_file","args":{"path":"a"}}},{"functionCall":{"id":"fc_2","name":"read_file","args":{"path":"b"}}},{"functionCall":{"id":"fc_3","name":"read_file","args":{"path":"c"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}`,
+		}},
+		{"thought signatures", []string{
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}},"thoughtSignature":"c2lnX2E="},{"functionCall":{"name":"read_file","args":{"path":"b"}},"thoughtSignature":"c2lnX2I="},{"functionCall":{"name":"read_file","args":{"path":"c"}},"thoughtSignature":"c2lnX2M="}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}`,
+		}},
+		{"thinking between the calls", []string{
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"plan","thought":true},{"functionCall":{"name":"read_file","args":{"path":"a"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"more","thought":true},{"functionCall":{"name":"read_file","args":{"path":"b"}}},{"functionCall":{"name":"read_file","args":{"path":"c"}}}]}}],"modelVersion":"m"}`,
+			`data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}`,
+		}},
+	}
+	for _, tc := range cases {
+		t.Run(tc.name, func(t *testing.T) {
+			up, _ := chatParallelUpstream(t)
+			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+			t.Setenv("XDG_CACHE_HOME", t.TempDir())
+			if err := provider.Save(provider.Provider{ID: "gem", Name: "Gem", Key: "AIza-test", Gemini: up.URL + "/v1beta", Models: []string{"m"}}); err != nil {
+				t.Fatal(err)
+			}
+			gw := httptest.NewServer(New().Handler())
+			defer gw.Close()
+			res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(
+				`{"model":"gem/m","stream":true,"messages":[{"role":"user","content":"x"}]}`))
+			if err != nil {
+				t.Fatal(err)
+			}
+			b, _ := io.ReadAll(res.Body)
+			res.Body.Close()
+			ids, _, finish := streamedToolCalls(t, string(b))
+			if res.StatusCode != 200 || len(ids) != 3 || finish != "tool_calls" {
+				t.Fatalf("status %d, %d calls, finish %q: %s", res.StatusCode, len(ids), finish, b)
+			}
+		})
+	}
+}
+
+// A reply asked whole carries the three calls in one tool_calls array.
+func TestChatWireParallelCallsWholeReply(t *testing.T) {
+	up, _ := chatParallelUpstream(t)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "gem", Name: "Gem", Key: "AIza-test", Gemini: up.URL + "/v1beta", Models: []string{"m"}}); err != nil {
+		t.Fatal(err)
+	}
+	gw := httptest.NewServer(New().Handler())
+	defer gw.Close()
+	res, err := http.Post(gw.URL+"/v1/chat/completions", "application/json", strings.NewReader(
+		`{"model":"gem/m","stream":false,"messages":[{"role":"user","content":"x"}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if n := len(gjson.Get(string(b), "choices.0.message.tool_calls").Array()); res.StatusCode != 200 || n != 3 {
+		t.Fatalf("status %d, %d calls: %s", res.StatusCode, n, b)
+	}
+}
+
+// The app's own genai wire, for the same chain: the calls reach a Gemini
+// client whole, one part each, and the replayed history keeps every call
+// and every answer.
+func TestGenaiWireParallelCalls(t *testing.T) {
+	up, bodies := chatParallelUpstream(t)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	if err := provider.Save(provider.Provider{ID: "gem", Name: "Gem", Key: "AIza-test", Gemini: up.URL + "/v1beta", Models: []string{"gemini-4-argon"}}); err != nil {
+		t.Fatal(err)
+	}
+	gw := httptest.NewServer(New().Handler())
+	defer gw.Close()
+	res, err := http.Post(gw.URL+"/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse", "application/json", strings.NewReader(
+		`{"contents":[{"role":"user","parts":[{"text":"call three tools in parallel"}]}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	b, _ := io.ReadAll(res.Body)
+	res.Body.Close()
+	if res.StatusCode != 200 {
+		t.Fatalf("status %d: %s", res.StatusCode, b)
+	}
+	n := 0
+	for _, line := range strings.Split(string(b), "\n") {
+		line = strings.TrimSpace(line)
+		if !strings.HasPrefix(line, "data: ") {
+			continue
+		}
+		for _, p := range gjson.Get(strings.TrimPrefix(line, "data: "), "candidates.0.content.parts").Array() {
+			if p.Get("functionCall").Exists() {
+				n++
+			}
+		}
+	}
+	if n != 3 {
+		t.Fatalf("the genai wire reply carries %d functionCalls: %s", n, b)
+	}
+	res2, err := http.Post(gw.URL+"/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse", "application/json", strings.NewReader(
+		`{"contents":[{"role":"user","parts":[{"text":"go"}]},
+		  {"role":"model","parts":[{"functionCall":{"id":"call_1","name":"read_file","args":{"path":"a"}}},{"functionCall":{"id":"call_2","name":"read_file","args":{"path":"b"}}},{"functionCall":{"id":"call_3","name":"read_file","args":{"path":"c"}}}]},
+		  {"role":"user","parts":[{"functionResponse":{"id":"call_1","name":"read_file","response":{"output":"a-file"}}},{"functionResponse":{"id":"call_2","name":"read_file","response":{"output":"b-file"}}},{"functionResponse":{"id":"call_3","name":"read_file","response":{"output":"c-file"}}}]}]}`))
+	if err != nil {
+		t.Fatal(err)
+	}
+	b2, _ := io.ReadAll(res2.Body)
+	res2.Body.Close()
+	if res2.StatusCode != 200 {
+		t.Fatalf("follow-up status %d: %s", res2.StatusCode, b2)
+	}
+	bs := bodies()
+	if len(bs) != 2 {
+		t.Fatalf("upstream asked %d times", len(bs))
+	}
+	last := gjson.Get(bs[1], "contents").Raw
+	for _, s := range []string{"a-file", "b-file", "c-file", `"path":"a"`, `"path":"b"`, `"path":"c"`} {
+		if !strings.Contains(last, s) {
+			t.Fatalf("the genai replay lost %s: %s", s, last)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)

````
</details>

Patch 2 of 2 (wirings magpie starts go on genai): <details><summary>patch: agent: Antigravity wirings magpie starts go on genai (#5908) — git am applies it as is; SHA-256 first 16: c1dbfcd4ecfa1627</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 13 Nov 2026 03:35:35 +0800
Subject: [PATCH 2/2] agent: Antigravity wirings magpie starts go on genai
 (#5908)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The commit below keeps a wired file's wireProtocol what the file
holds, but a wiring magpie starts, and a file with no wire protocol
of its own, still landed on openai — and openai is the wire the
reporter's A/B convicts: same provider, same model, only wireProtocol
flipped, the turn of parallel tool calls retries for good on openai
and finishes on genai (#5908). genai is no new road: it is the wire
magpie serves its Antigravity-native accounts on, and the app reads
the same parallel calls whole on it — one functionCall part each,
ids, names and arguments intact — where its own openai accumulator
folds them into one.

So wirings magpie makes from now on start on genai. A file's own
value still wins, the reporter's hand-set genai and a hand-set
openai alike (TestAntigravityWireProtocolKept, and TestAntigravity-
SyncAddsCatalog, whose file wired on openai keeps it through a
sync). A wiring an older magpie left on openai crosses over at the
2.30 sync: the old settings.json is left as the 2.29 app has it,
and the config.json 2.30 reads starts on genai (TestAntigravitySync-
WiresConfigJSON) — a 2.30 user who wants openai sets it in
config.json, where magpie leaves it, as any hand-set value.

Run:
- Red first, on the tests the flip is read by: TestAntigravityGateway,
  TestAntigravityEffort, TestAntigravityConfigJSON and TestAntigravity-
  WireProtocolKept failed on this tree with only the assertions moved —
  "a block magpie starts writes \"openai\", want genai" among them —
  then pass with the default flipped.
- The explicit-openai half of TestAntigravityWireProtocolKept is new:
  with genai the default, a kept genai and the default read the same,
  so the keep branch had no test left that could tell it alive from
  dead; a hand-set openai that survives a sync can, and with the keep
  branch cut the test fails "an explicit openai didn't stay" — the
  user's explicit choice the reporter asked to keep.
- TestAntigravitySyncAddsCatalog and the genai half of TestAntigravity-
  WireProtocolKept stayed green throughout: a file's own wireProtocol
  still survives magpie's writes and syncs. TestAntigravityGatewayFrom-
  Nothing never reads the value: green before and after.
- Ablations, each made against the committed fix and reverted after:
  the default hunk turned back to openai fails all four flipped
  assertions; the keep hunk cut fails the explicit-openai one.
- go test -tags nogui ./internal/agent -run TestAntigravity: all 12
  named tests green. The whole agent package: green but TestMothX, red on the
  parent commit too on this machine (b9f22e9de, checked out alone).
- The whole gateway package (which holds the parallel-calls wire
  fixtures the first commit added): green, 1024.0s, no failures.
- The named agent tests and the parallel-calls wire fixtures again
  with -race: green. gofmt -l empty; go vet clean; GOOS=linux/windows/
  darwin go build (-tags nogui) green.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/antigravity.go      | 16 ++++++-----
 internal/agent/antigravity_test.go | 44 ++++++++++++++++++++----------
 2 files changed, 39 insertions(+), 21 deletions(-)

diff --git a/internal/agent/antigravity.go b/internal/agent/antigravity.go
index 463e8834b..0fb913dff 100644
--- a/internal/agent/antigravity.go
+++ b/internal/agent/antigravity.go
@@ -123,14 +123,16 @@ func (f agyFile) wired() bool {
 }
 
 // antigravityGateway is the gateway block magpie writes at path. The wire
-// protocol stays the file's once it holds one: on the app's openai stream
-// its own accumulator folds a turn's parallel calls into one, their ids,
-// names and arguments lost (#5908), and on genai it reads them whole, so
-// the protocol of a wired file is the user's to pick (a Gemini-native
-// provider's row wants genai). A file with none is put on openai, as
-// before, and so is a block magpie starts.
+// protocol stays the file's once it holds one. A file with none, and a
+// block magpie starts, go on genai: on the app's openai stream its own
+// accumulator folds a turn's parallel calls into one, their ids, names
+// and arguments lost, and the turn retries for good (#5908 — the
+// reporter's A/B had the same provider and model finish on genai and
+// retry on openai), while on genai — the wire magpie serves its
+// Antigravity-native accounts on — the app reads the same calls whole.
+// openai stays the user's to set: a file naming it keeps it.
 func antigravityGateway(path string) map[string]any {
-	proto := "openai"
+	proto := "genai"
 	if path != "" {
 		if v, _ := edit.GetJSON(path, "gateway.wireProtocol"); strings.TrimSpace(v) != "" {
 			proto = v
diff --git a/internal/agent/antigravity_test.go b/internal/agent/antigravity_test.go
index 124b63808..d197a6e03 100644
--- a/internal/agent/antigravity_test.go
+++ b/internal/agent/antigravity_test.go
@@ -88,7 +88,7 @@ func TestAntigravityGateway(t *testing.T) {
 	file := antigravityFile(t, path)
 	var gw map[string]any
 	json.Unmarshal(file["gateway"], &gw)
-	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}
+	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "genai"}
 	if !sameJSON(string(file["gateway"]), want) {
 		t.Errorf("gateway: %s, want %v", file["gateway"], want)
 	}
@@ -378,7 +378,7 @@ func TestAntigravityEffort(t *testing.T) {
 	if err := f.Set("hard"); err == nil {
 		t.Fatal("a word that isn't a level was kept")
 	}
-	if !sameJSON(string(antigravityFile(t, path)["gateway"]), map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}) {
+	if !sameJSON(string(antigravityFile(t, path)["gateway"]), map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "genai"}) {
 		t.Errorf("the pick touched the app's gateway: %s", readFile(path))
 	}
 	if err := f.Set(""); err != nil || provider.AgentEffort("antigravity") != "" {
@@ -483,7 +483,7 @@ func TestAntigravityConfigJSON(t *testing.T) {
 	if err := f.Set("magpie/anth/claude-sonnet-5"); err != nil {
 		t.Fatal(err)
 	}
-	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}
+	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "genai"}
 	models := map[string]any{"defaultModelId": "anth/claude-sonnet-5", "listSource": gateway.URL() + "/v1/models?format=antigravity"}
 	for _, p := range []string{cfg, legacy} {
 		file := antigravityFile(t, p)
@@ -518,7 +518,9 @@ func TestAntigravityConfigJSON(t *testing.T) {
 // A settings.json a magpie before 2.30's file wired, beside the
 // config.json 2.30 wrote, gets the same block into config.json on the
 // next sync, at the level it starts on; turning it off then gives both
-// back.
+// back. The block's wire protocol is the one a wiring magpie starts on
+// now (genai) — the old file keeps the openai an older magpie put there,
+// and only the 2.29 app reads that one.
 func TestAntigravitySyncWiresConfigJSON(t *testing.T) {
 	home := antigravityHome(t)
 	cfg := filepath.Join(home, ".gemini", "config", "config.json")
@@ -534,7 +536,7 @@ func TestAntigravitySyncWiresConfigJSON(t *testing.T) {
 		t.Fatal(err)
 	}
 	file := antigravityFile(t, cfg)
-	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}
+	want := map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "genai"}
 	if !sameJSON(string(file["gateway"]), want) {
 		t.Fatalf("config.json's gateway after sync: %s", readFile(cfg))
 	}
@@ -561,13 +563,15 @@ func TestAntigravitySyncWiresConfigJSON(t *testing.T) {
 	}
 }
 
-// The wire protocol of a file on magpie stays what the file holds: on the
-// app's openai stream its own accumulator folds a turn's parallel calls
-// into one (id, names and arguments lost, #5908), and on genai it reads
-// them whole, so the protocol is the user's to pick once magpie wired the
-// file (the reporter hand-set genai and had it work until magpie's next
-// write put openai back). What magpie writes still refreshes; a file with
-// no wire protocol of its own is put on openai, as before.
+// The wire protocol of a file on magpie stays what the file holds once it
+// holds one: on the app's openai stream its own accumulator folds a turn's
+// parallel calls into one (id, names and arguments lost, #5908), and on
+// genai it reads them whole. So a wiring magpie starts, and a file with no
+// wire protocol of its own, go on genai — the wire the app reads the same
+// calls whole on, as the reporter's A/B had it (openai kept retrying the
+// turn, genai finished) — and openai stays the user's to set: a file
+// naming it keeps it, and the reporter's hand-set genai survives magpie's
+// writes, as before.
 func TestAntigravityWireProtocolKept(t *testing.T) {
 	home := antigravityHome(t)
 	path := filepath.Join(home, ".antigravity", "settings.json")
@@ -577,8 +581,8 @@ func TestAntigravityWireProtocolKept(t *testing.T) {
 	if err := f.Set("magpie/anth/claude-sonnet-5"); err != nil {
 		t.Fatal(err)
 	}
-	if got, _ := edit.GetJSON(path, "gateway.wireProtocol"); got != "openai" {
-		t.Fatalf("a block magpie starts writes %q, want openai", got)
+	if got, _ := edit.GetJSON(path, "gateway.wireProtocol"); got != "genai" {
+		t.Fatalf("a block magpie starts writes %q, want genai", got)
 	}
 	// the reporter's pick, hand-set in magpie's own block
 	if err := edit.SetJSON(path, edit.KV{Path: "gateway.wireProtocol", Value: "genai"}); err != nil {
@@ -594,4 +598,16 @@ func TestAntigravityWireProtocolKept(t *testing.T) {
 	if file := antigravityFile(t, path); !sameJSON(string(file["gateway"]), want) {
 		t.Fatalf("the wire protocol didn't stay the user's: %s", readFile(path))
 	}
+	// an explicit openai keeps, too: the app's folding accumulator on
+	// that wire is the user's to accept if they name it
+	if err := edit.SetJSON(path, edit.KV{Path: "gateway.wireProtocol", Value: "openai"}); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	want = map[string]any{"enabled": true, "url": gateway.URL(), "apiKey": agentKey("antigravity"), "wireProtocol": "openai"}
+	if file := antigravityFile(t, path); !sameJSON(string(file["gateway"]), want) {
+		t.Fatalf("an explicit openai didn't stay: %s", readFile(path))
+	}
 }
-- 
2.50.1 (Apple Git-155)

````
</details>
