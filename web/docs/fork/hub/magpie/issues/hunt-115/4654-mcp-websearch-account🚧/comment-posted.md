Fixed on `f823657d7` (patch below). The run now keeps the gateway key its first turn came with, and the helper callback's search goes as that key.

**What changed**

- `internal/gateway/claude_subscription.go`: a `subscriptionRun` records `callerKeyID` (`access.Caller`'s KeyID) as it starts, and `mcpCall`'s search branch rebuilds the caller from it with the new `access.IdentityByID` (`internal/access/access.go`), reading the key's current settings at that moment — so a key narrowed since the run started holds the search to what it holds now. A key that no longer resolves (removed or disabled) fails the search closed as a tool error instead of going out as an unrestricted caller. A caller that came with no key keeps today's behavior (no identity to lose).
- A run started for one key is never resumed for a turn that came with another, on both reuse paths: the tool-results match in `serveSubscription` (logged as "another gateway key") and the idle-run `resume` in `serveClaudeSubscription`'s start. Without that, the stored identity would be the first key's for the second key's turn.
- The usage rows need no change of their own: `appendUsage`, the search-API row and `logNativeSearches` all read the caller from the context, so once the search's context carries the key they name it.

**Red without the fix** (base `f823657d7`, tests kept, product files reverted by hand): new tests in `internal/gateway/claude_search_caller_test.go` — a stand-in Claude Code calls magpie's web search through the real helper callback, a fake DeepSeek searcher sits behind two keys, and the gateway key is held to the second of them.

| Test | Without the fix | With the fix |
| --- | --- | --- |
| `TestClaudeRunWebSearchKeepsTheCallingKey` | FAIL: `the searches went out as ["Bearer first" "Bearer first"]; want the key's account, the second key` | PASS |
| `TestClaudeRunWebSearchFailsClosedWhenTheKeyStops` | FAIL: `2 searches went out; the second had to be declined` | PASS |
| `TestClaudeRunIsNotKeptForAnotherKey` | FAIL: `the second key's turn went on in the first key's run: 1 run(s) started` | PASS |
| `TestClaudeRunIdleIsNotKeptForAnotherKey` | FAIL: `1 run(s) started` | PASS |

Ablating each part on its own turns its test red again: dropping the identity rebuild in `mcpCall` fails both search tests (`Bearer first`, and the second search going out after the key was disabled), dropping the tool-results guard fails `TestClaudeRunIsNotKeptForAnotherKey`, dropping the idle guard fails `TestClaudeRunIdleIsNotKeptForAnotherKey`.

**Verified**: `go test -tags nogui -count=1 ./internal/gateway/` (578s) and `./internal/access/` ok on darwin/arm64 at `d1fc7cb7f`; the four tests also pass with `-race`; `gofmt -l` clean; `go vet -tags nogui` and `GOOS=linux` / `GOOS=windows` vet clean for both packages; `go build -tags nogui ./...` on darwin, linux and windows (the `internal/gui` cgo warning on darwin is pre-existing on the untouched gui package).

**Other calls from the callback path**: `mcpCall`'s only outbound call is the search — `waitTool`/`await` and the pending-tool-result branches answer from the client and never reach a provider. The picture description (`vision.go`) and Codex titles build their requests from the caller's own request context, which carries the identity, so they are not affected. Both `claudeMCPPath` registrations (the gateway's and the handover mux) serve the same `mcpCall`. Reading the key again per search takes one read of caller-keys.json per web search, not per request.

**Not verified**: no real Claude subscription account or restricted key against the production gateway — the reproduction is the package's own stand-in with fake upstreams, offline.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: hold a subscription run's web search to its key's accounts (#4654) — git am applies it as is; SHA-256 first 16: ab889994f1a1d852</summary>

```
From d1fc7cb7fe36d7e74a4bbf7d352a16679940ea92 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 17:42:41 +0800
Subject: [PATCH] gateway: hold a subscription run's web search to its key's
 accounts

A Claude Code subscription run's web search went out from the MCP
helper's callback request (/_magpie/claude-mcp/<token>), which carries
no caller identity, so the search was made as an unrestricted caller:
a gateway key held to some accounts had its searches served by the
first account of the shared order, and the search's usage row named no
key (#4654).

The run now keeps the key its first turn came with. The callback search
goes as that key, read again as the search is made, so a key narrowed
since the run started holds the search to what it holds now, and one
removed or disabled fails the search closed rather than sending it as
an unrestricted caller. A run is also never resumed for a turn that
came with another key, on the tool-results path and on the idle one.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/access/access.go                     |  36 ++
 internal/gateway/claude_search_caller_test.go | 373 ++++++++++++++++++
 internal/gateway/claude_subscription.go       |  53 ++-
 3 files changed, 459 insertions(+), 3 deletions(-)
 create mode 100644 internal/gateway/claude_search_caller_test.go

diff --git a/internal/access/access.go b/internal/access/access.go
index 7b7570c89..bb82f8ace 100644
--- a/internal/access/access.go
+++ b/internal/access/access.go
@@ -584,6 +584,42 @@ func On(id string) bool {
 	return false
 }
 
+// IdentityByID is who the key with this id is now, judged as Check judges
+// it: false when no such key is in the store, or it is turned off,
+// expired, or issued under one that no longer lets it in. A request's
+// caller rides its context, but a run's helper callback comes with none
+// (#4654) — the run keeps the key's id, and the caller is read again here
+// as the search is made, so a key narrowed or stopped since the run
+// started holds what it holds now, and one that no longer works is failed
+// closed rather than sent as an unrestricted caller.
+func IdentityByID(id string) (Identity, bool) {
+	mu.Lock()
+	defer mu.Unlock()
+	keys, err := load()
+	if err != nil || id == "" {
+		return Identity{}, false
+	}
+	i := slices.IndexFunc(keys, func(k Key) bool { return k.ID == id })
+	if i < 0 {
+		s := settings.Load()
+		if s.LAN && s.LANKeyID == "" && s.LANKey != "" && !strings.HasPrefix(s.LANKey, revokedLANPrefix) && !slices.ContainsFunc(keys, func(k Key) bool { return k.LAN }) {
+			if k := legacyLANKey(s.LANKey); k.ID == id {
+				return Identity{KeyID: k.ID, KeyName: k.Name, Default: true}, true
+			}
+		}
+		return Identity{}, false
+	}
+	k := keys[i]
+	if k.Off {
+		return Identity{}, false
+	}
+	who, err := identityOf(k, keys, Now())
+	if err != nil {
+		return Identity{}, false
+	}
+	return who, true
+}
+
 func legacyLANKey(secret string) Key {
 	// The fallback and eventual persisted key must share their usage identity.
 	sum := sha256.Sum256([]byte(secret))
diff --git a/internal/gateway/claude_search_caller_test.go b/internal/gateway/claude_search_caller_test.go
new file mode 100644
index 000000000..8b00c5300
--- /dev/null
+++ b/internal/gateway/claude_search_caller_test.go
@@ -0,0 +1,373 @@
+package gateway
+
+import (
+	"context"
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"os/exec"
+	"path/filepath"
+	"regexp"
+	"runtime"
+	"slices"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/access"
+	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/settings"
+	"github.com/yetone/magpie/internal/testenv"
+	"github.com/yetone/magpie/internal/usage"
+)
+
+// searchUpstream is a fake DeepSeek Responses API that notes the credential
+// every search came with: two keys behind one provider, and what the
+// gateway key's accounts hold is read off which of them the search went
+// on (#4654).
+type searchUpstream struct {
+	*httptest.Server
+	mu   sync.Mutex
+	auth []string
+}
+
+func newSearchUpstream(t *testing.T) *searchUpstream {
+	f := &searchUpstream{}
+	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if strings.HasSuffix(r.URL.Path, "/models") {
+			io.WriteString(w, `{"data":[{"id":"deepseek-flash"}]}`)
+			return
+		}
+		f.mu.Lock()
+		f.auth = append(f.auth, r.Header.Get("Authorization"))
+		f.mu.Unlock()
+		if !strings.HasSuffix(r.URL.Path, "/responses") {
+			http.NotFound(w, r)
+			return
+		}
+		w.Header().Set("Content-Type", "text/event-stream")
+		io.WriteString(w, sse(
+			`data: {"type":"response.created","response":{"id":"r1","model":"deepseek-flash"}}`,
+			`data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed","action":{"type":"search","query":"weather today","sources":[{"type":"url","url":"https://www.weather.com/"}]}}}`,
+			`data: {"type":"response.output_text.delta","delta":"Rain in Shanghai today, 22/17C."}`,
+			`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":4000,"output_tokens":20}}}`))
+	}))
+	t.Cleanup(f.Close)
+	return f
+}
+
+func (f *searchUpstream) credentials() []string {
+	f.mu.Lock()
+	defer f.mu.Unlock()
+	return slices.Clone(f.auth)
+}
+
+// searchClaude stands in for Claude Code: each turn it calls magpie's web
+// search through the MCP helper callback, then replies with what it got.
+// With a sentinel path set it waits for that file after the first search,
+// so the test may change the world (a key disabled) between the two
+// searches the one turn makes.
+func searchClaude(t *testing.T, sentinel string) string {
+	t.Helper()
+	if runtime.GOOS == "windows" {
+		t.Skip("a shell script stands in for Claude Code")
+	}
+	if _, err := exec.LookPath("curl"); err != nil {
+		t.Skip("the script makes its MCP calls with curl")
+	}
+	dir := t.TempDir()
+	log := filepath.Join(dir, "stdin.log")
+	// its curl calls back past any proxy, as the helper does (#2440)
+	wait := ""
+	if sentinel != "" {
+		wait = `while [ ! -f '` + sentinel + `' ]; do sleep 0.05; done; `
+	}
+	script := `#!/bin/sh
+echo "args $*" >> ` + log + `
+cb=$(cat "$(printf '%s\n' "$@" | grep -o '"claude-mcp-helper","[^"]*"' | head -1 | sed 's/.*","//; s/"$//')")
+n=0
+start() { echo '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m'$n'","model":"claude-sonnet-5","usage":{"input_tokens":1}}}}'; }
+text() { echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'"$1"'"}}}'; }
+tool() {
+  echo '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_T'$1'","name":"mcp__magpie__web_search"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"weather today\"}"}}}'
+  echo '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'
+  echo '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}}'
+  echo '{"type":"stream_event","event":{"type":"message_stop"}}'
+}
+finish() {
+  echo '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}}'
+  echo '{"type":"stream_event","event":{"type":"message_stop"}}'
+  echo '{"type":"result","subtype":"success","is_error":false,"result":""}'
+}
+search() {
+  n=$((n+1))
+  start
+  tool $n
+  got=$(curl --noproxy '*' -sS -X POST -H 'Content-Type: application/json' --data '{"tool_call_id":"toolu_T'$n'","name":"web_search","arguments":{"query":"weather today"}}' "$cb" 2>> ` + log + `)
+  echo "got$n $got" >> ` + log + `
+}
+while read -r line; do
+  printf '%s\n' "$line" >> ` + log + `
+  case "$line" in *control_request*) continue;; esac
+  search
+  ` + wait + `
+  search
+  start
+  text "searched the weather."
+  finish
+done
+`
+	testenv.Program(t, filepath.Join(dir, "claude"), script)
+	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
+	return log
+}
+
+// searchRun is the issue's setup (#4654): a searcher with two keys, a
+// gateway key held to the second of them, and a run of the Claude
+// subscription started by a request that came with that key. The run's
+// Claude Code calls magpie's web search, which the helper hands back over
+// the callback path.
+func searchRun(t *testing.T, sentinel string) (*Server, *searchUpstream, access.Identity, string) {
+	t.Helper()
+	fresh(t)
+	up := newSearchUpstream(t)
+	searchesOn(t, provider.Responses, up.URL)
+	if err := provider.Save(provider.Provider{ID: "ds", Name: "DeepSeek", Key: "first", Keys: []provider.KeyAccount{{Key: "second"}}, Responses: up.URL + "/v1", Models: []string{"deepseek-flash"}}); err != nil {
+		t.Fatal(err)
+	}
+	st := settings.Load()
+	st.Searcher = "ds/deepseek-flash"
+	if err := settings.Save(st); err != nil {
+		t.Fatal(err)
+	}
+	keys, secrets := newCaller(t, "Restricted")
+	if _, err := access.Update("accounts-key", access.Change{Key: keys[0].ID, Accounts: []string{"ds/" + provider.KeyID("second")}}); err != nil {
+		t.Fatal(err)
+	}
+	who, err := access.Check(secrets[0])
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !slices.Contains(who.Accounts, "ds/"+provider.KeyID("second")) {
+		t.Fatalf("the key is not held to the second key: %+v", who)
+	}
+	s := New()
+	srv := httptest.NewServer(s.Handler())
+	t.Cleanup(srv.Close)
+	t.Cleanup(s.subscription.abortAll) // before srv.Close: a run's MCP call holds a request open
+	t.Setenv("MAGPIE_ADDR", srv.Listener.Addr().String())
+	log := searchClaude(t, sentinel)
+	t.Cleanup(func() { _ = log })
+	return s, up, who, log
+}
+
+// The search a subscription run makes goes as the gateway key the run
+// started for (#4654): the helper's callback carries no identity of its
+// own, and a key held to some accounts had its searches served by the
+// first account of the shared order, named by no key in the usage.
+func TestClaudeRunWebSearchKeepsTheCallingKey(t *testing.T) {
+	s, up, who, log := searchRun(t, "")
+	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
+	body := `{"model":"claude-sonnet-5","max_tokens":100,"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search the weather for me"}]}`
+	rec := httptest.NewRecorder()
+	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)).WithContext(access.WithIdentity(context.Background(), who))
+	var u Usage
+	if code, msg := s.serveClaudeSubscription(rec, req, provider.Anthropic, p, "claude-sonnet-5", []byte(body), &u); code != 200 {
+		t.Fatalf("%d %s", code, msg)
+	}
+	var reply struct {
+		Content []struct{ Type, Text string }
+	}
+	said, _ := os.ReadFile(log)
+	if err := json.Unmarshal(rec.Body.Bytes(), &reply); err != nil || len(reply.Content) == 0 {
+		t.Fatalf("no answer: %s %v (log:\n%s)", rec.Body, err, said)
+	}
+	// the helper came back with the search, twice
+	if n := strings.Count(string(said), "22/17C"); n != 2 {
+		t.Fatalf("the run's searches did not both come back (%d): %s", n, said)
+	}
+	// the searches went on the key the run is for, not the first of the
+	// shared order
+	got := up.credentials()
+	if len(got) != 2 || got[0] != "Bearer second" || got[1] != "Bearer second" {
+		t.Fatalf("the searches went out as %q; want the key's account, the second key", got)
+	}
+	// its usage row names the key
+	named := false
+	for _, r := range usage.Load(time.Time{}) {
+		if r.Provider == "ds" && r.Model == "deepseek-flash" {
+			named = true
+			if r.CallerKeyID != who.KeyID {
+				t.Fatalf("the search's usage row names no key: %+v", r)
+			}
+		}
+	}
+	if !named {
+		t.Fatal("the search left no usage row behind")
+	}
+}
+
+// A key disabled (or removed) since the run started holds the run's
+// searches out too: the search fails closed rather than going as an
+// unrestricted caller (#4654). The key is turned off between the two
+// searches the one turn makes, the second of which must be declined.
+func TestClaudeRunWebSearchFailsClosedWhenTheKeyStops(t *testing.T) {
+	sentinel := filepath.Join(t.TempDir(), "key-off")
+	s, up, who, log := searchRun(t, sentinel)
+	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
+	body := `{"model":"claude-sonnet-5","max_tokens":100,"tools":[{"type":"web_search_20250305","name":"web_search"}],"messages":[{"role":"user","content":"search the weather twice"}]}`
+	code := make(chan int, 1)
+	go func() {
+		rec := httptest.NewRecorder()
+		req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)).WithContext(access.WithIdentity(context.Background(), who))
+		var u Usage
+		c, _ := s.serveClaudeSubscription(rec, req, provider.Anthropic, p, "claude-sonnet-5", []byte(body), &u)
+		code <- c
+	}()
+	// the first search answered, and its result came back to the helper
+	deadline := time.Now().Add(20 * time.Second)
+	for {
+		b, _ := os.ReadFile(log)
+		if strings.Contains(string(b), "got1 ") {
+			break
+		}
+		if time.Now().After(deadline) {
+			t.Fatalf("the first search never came back (log:\n%s)", b)
+		}
+		time.Sleep(10 * time.Millisecond)
+	}
+	// the key stops; the second search must not go as an unrestricted
+	// caller
+	if _, err := access.Update("off-key", access.Change{Key: who.KeyID}); err != nil {
+		t.Fatal(err)
+	}
+	os.WriteFile(sentinel, []byte("off"), 0o644)
+	if c := <-code; c != 200 {
+		t.Fatalf("the turn ended %d (log:\n%s)", c, log)
+	}
+	b, _ := os.ReadFile(log)
+	if n := len(up.credentials()); n != 1 {
+		t.Fatalf("%d searches went out; the second had to be declined (log:\n%s)", n, b)
+	}
+	got := regexp.MustCompile(`got2 (.*)`).FindStringSubmatch(string(b))
+	if len(got) != 2 {
+		t.Fatalf("the second search never came back (log:\n%s)", b)
+	}
+	if !strings.Contains(got[1], "search failed") || strings.Contains(got[1], "22/17C") {
+		t.Fatalf("the second search was not failed closed for its key: %s", got[1])
+	}
+}
+
+// askAs is the rewind harness's ask, the turn coming as a gateway key's
+// caller.
+func (h *rewindHarness) askAs(who access.Identity, msgs string) string {
+	h.t.Helper()
+	body := h.body(msgs)
+	rec := httptest.NewRecorder()
+	var u Usage
+	if code, msg := h.s.serveClaudeSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)).WithContext(access.WithIdentity(context.Background(), who)), provider.Anthropic, h.p, "claude-sonnet-5", []byte(body), &u); code != 200 {
+		h.t.Fatalf("%d %s", code, msg)
+	}
+	var res struct {
+		Content []struct{ Text string } `json:"content"`
+	}
+	json.Unmarshal(rec.Body.Bytes(), &res)
+	if len(res.Content) == 0 {
+		h.t.Fatalf("no answer: %s", rec.Body)
+	}
+	return res.Content[0].Text
+}
+
+// askAs is ask, the turn coming as a gateway key's caller.
+func (h *remapHarness) askAs(who access.Identity, msgs ...string) []string {
+	h.t.Helper()
+	body := `{"model":"claude-sonnet-5","max_tokens":100,"tools":[{"name":"read","input_schema":{"type":"object"}}],"messages":[` + strings.Join(msgs, ",") + `]}`
+	rec := httptest.NewRecorder()
+	var u Usage
+	if code, msg := h.s.serveSubscription(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body)).WithContext(access.WithIdentity(context.Background(), who)), provider.Anthropic, "Claude Code", "claude-sonnet-5", "", []byte(body), &u, h.start); code != 200 {
+		h.t.Fatalf("%d %s", code, msg)
+	}
+	var res struct {
+		Content []struct{ Type, Text, ID string } `json:"content"`
+	}
+	json.Unmarshal(rec.Body.Bytes(), &res)
+	var out []string
+	for _, c := range res.Content {
+		out = append(out, c.Type+" "+c.Text+c.ID)
+	}
+	return out
+}
+
+// A run started for one gateway key is never resumed for another (#4654):
+// its searches would go on the key it was started for, not the one the
+// later turn came with.
+func TestClaudeRunIsNotKeptForAnotherKey(t *testing.T) {
+	fresh(t)
+	keys, secrets := newCaller(t, "First key", "Second key")
+	h := newRemapHarness(t)
+	h.first = func(run *subscriptionRun, req *Request) {
+		waiters := h.calls(run, true, shownCall{"call-a", "read", `{}`})
+		go func() {
+			_, ok := <-waiters[0]
+			if ok {
+				h.says(run, "kept run")
+			}
+		}()
+	}
+	who1, err := access.Check(secrets[0])
+	if err != nil {
+		t.Fatal(err)
+	}
+	who2, err := access.Check(secrets[1])
+	if err != nil {
+		t.Fatal(err)
+	}
+	if out := h.askAs(who1, remapUser("go")); len(out) == 0 || !strings.HasPrefix(out[0], "tool_use") {
+		t.Fatalf("the first turn never called the tool: %q", out)
+	}
+	// the results come back under another key: the run is the first key's
+	out := h.askAs(who2, remapUser("go"), remapCalls("call-a={}"), remapResults("call-a=result"))
+	if len(out) == 0 {
+		t.Fatalf("the second turn got no answer: %q", out)
+	}
+	if h.runs() != 2 {
+		t.Fatalf("the second key's turn went on in the first key's run: %d run(s) started", h.runs())
+	}
+	_ = keys
+}
+
+// An idle run kept for the next turn keeps its key's turn on it, and is
+// never resumed for another key's (#4654): the searches the kept run makes
+// on the helper's callback go on the key it was started for.
+func TestClaudeRunIdleIsNotKeptForAnotherKey(t *testing.T) {
+	fresh(t)
+	_, secrets := newCaller(t, "First key", "Second key")
+	h := newRewindHarness(t, "ok")
+	who1, err := access.Check(secrets[0])
+	if err != nil {
+		t.Fatal(err)
+	}
+	who2, err := access.Check(secrets[1])
+	if err != nil {
+		t.Fatal(err)
+	}
+	first := h.askAs(who1, `[{"role":"user","content":"hello"}]`)
+	pid := regexp.MustCompile(`pid [0-9]+ turn [0-9]+`).FindString(first)
+	if pid == "" {
+		t.Fatalf("no run answered: %q", first)
+	}
+	// the run is kept for the next turn of its own key
+	next := h.askAs(who1, `[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"`+pid+`"}]},{"role":"user","content":"again"}]`)
+	if !strings.Contains(next, strings.Replace(pid, "turn 1", "turn 2", 1)) {
+		t.Fatalf("the run was not kept for its own key's next turn: %q (log:\n%s)", next, h.read())
+	}
+	// another key's turn starts a run of its own
+	h.askAs(who2, `[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"text","text":"`+pid+`"}]},{"role":"user","content":"again"},{"role":"assistant","content":[{"type":"text","text":"`+strings.Replace(pid, "turn 1", "turn 2", 1)+`"}]},{"role":"user","content":"once more"}]`)
+	if n := strings.Count(h.read(), "args "); n != 2 {
+		t.Fatalf("the second key's turn went on in the first key's run (%d run(s) started, log:\n%s)", n, h.read())
+	}
+}
diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 63b7888e5..9a3b6463e 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -58,6 +58,8 @@ import (
 	"sync"
 	"sync/atomic"
 	"time"
+
+	"github.com/yetone/magpie/internal/access"
 	"unicode/utf8"
 
 	"github.com/yetone/magpie/internal/appdir"
@@ -267,8 +269,16 @@ type subscriptionRun struct {
 	// client never sees
 	search     func(ctx context.Context, query string) (string, []Hit, error)
 	searchName string
-	begin      func() Event
-	resume     func() // after a resumed turn has its segment
+	// callerKeyID is the gateway key the run's first turn came with
+	// (access.Caller's KeyID, "" for a caller that came with none), read
+	// again as its searches are made: the helper's callback carries no
+	// caller of its own, and the key's accounts hold the searches the run
+	// makes as they hold its turns (#4654). A run is never resumed for a
+	// turn that came with another key. Set as the run starts; read under
+	// mu.
+	callerKeyID string
+	begin       func() Event
+	resume      func() // after a resumed turn has its segment
 
 	// patience, when set, is how long a tool call may park before the agent
 	// is told it is still running (its MCP client gives up on a call at a
@@ -331,6 +341,14 @@ type callLine struct {
 	told string
 }
 
+// startedFor is the gateway key the run's first turn came with, "" for a
+// caller that came with none (#4654).
+func (r *subscriptionRun) startedFor() string {
+	r.mu.Lock()
+	defer r.mu.Unlock()
+	return r.callerKeyID
+}
+
 // linesMost is how many call lines a run keeps (lines).
 const linesMost = 256
 
@@ -4093,6 +4111,7 @@ const (
 	runExpired     = "process expired"
 	noRunWaiting   = "no run waiting"
 	accountChanged = "account changed"
+	anotherKey     = "another gateway key"
 	// another request has the run's calls answered, or is answering them
 	answeredElsewhere = "answered by another request"
 )
@@ -4663,6 +4682,7 @@ func (b *subscriptionBridge) mcpCall(w http.ResponseWriter, r *http.Request) {
 	run.mu.Lock()
 	call.Name = declaredName(run.names, call.Name)
 	search, searchName := run.search, run.searchName
+	callerKeyID := run.callerKeyID
 	run.mu.Unlock()
 	if search != nil && call.Name == searchName {
 		var a struct {
@@ -4672,6 +4692,19 @@ func (b *subscriptionBridge) mcpCall(w http.ResponseWriter, r *http.Request) {
 		// within the minute its MCP client waits for a call
 		ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
 		defer cancel()
+		// the helper's callback comes with no caller of its own; the run
+		// keeps it (#4654). The key's accounts hold the search as they
+		// hold the run's turns, and one disabled or removed since the run
+		// started holds the search out: failed closed, never sent as an
+		// unrestricted caller.
+		if callerKeyID != "" {
+			who, ok := access.IdentityByID(callerKeyID)
+			if !ok {
+				writeJSON(w, 200, mcpToolResult{Content: []map[string]any{{"type": "text", "text": "search failed: the gateway key this run started under no longer works (it was removed or disabled), so magpie declined the web search"}}, IsError: true})
+				return
+			}
+			ctx = access.WithIdentity(ctx, who)
+		}
 		found, hits, err := search(ctx, a.Query)
 		if err != nil {
 			writeJSON(w, 200, mcpToolResult{Content: []map[string]any{{"type": "text", "text": "search failed: " + err.Error()}}, IsError: true})
@@ -5290,7 +5323,13 @@ func (s *Server) serveClaudeSubscription(w http.ResponseWriter, r *http.Request,
 	start := func(ctx context.Context, req *Request) (*subscriptionRun, <-chan Event, error) {
 		ctx = p.Via(ctx) // the account's own proxy, its CLI run's too
 		if run, events := s.subscription.resume(req, owner); run != nil {
-			return run, events, nil
+			// a run kept for the next turn goes on for its own key's turn,
+			// never for another key's (#4654): the searches it makes on the
+			// helper's callback go on the key it was started for
+			if run.startedFor() == access.Caller(ctx).KeyID {
+				return run, events, nil
+			}
+			run.abortFor("it was started for another gateway key")
 		}
 		// a run let go past idleMost left its session for this turn, or
 		// the run whose calls another request answered first has it
@@ -5448,6 +5487,13 @@ func (s *Server) serveSubscription(w http.ResponseWriter, r *http.Request, from
 		run.abort()
 		run, how = nil, accountChanged
 	}
+	// a run started for one gateway key is never resumed for another
+	// (#4654): the searches its agent makes on the helper's callback go on
+	// the key the run is for, not the one this turn came with
+	if run != nil && run.startedFor() != access.Caller(r.Context()).KeyID {
+		run.abort()
+		run, how = nil, anotherKey
+	}
 	// the client rewrote the conversation since the run's last reply, as Pi
 	// does compacting it mid-turn: the run's agent holds the one from before,
 	// would answer from it, and tell the client a context as large as ever,
@@ -5527,6 +5573,7 @@ func (s *Server) serveSubscription(w http.ResponseWriter, r *http.Request, from
 			if search.Name != "" {
 				run.search, run.searchName = s.webSearch, search.Name
 			}
+			run.callerKeyID = access.Caller(r.Context()).KeyID
 			run.mu.Unlock()
 		}
 	}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [hunt115-b3-4654](https://github.com/ggbdpq/magpie/tree/hunt115-b3-4654) (head `d1fc7cb7f`).
