package gateway

// Probe for #4608: a Codex lead on sol spawning a luna subagent — does the
// subagent's usage reach the ledger? Two scenes: nothing set for Codex's
// subagents (the request stays on the luna its lead named, relayed), and a
// model set (moved). Delete this file after the verdict.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/usage"
)

func probeSetup(t *testing.T, asked *[]string) {
	t.Helper()
	codexSignedIn(t, "spare@example.com")
	home, _ := os.UserHomeDir()
	os.WriteFile(filepath.Join(home, ".codex", "models_cache.json"), []byte(`{"etag":"\"v1\"","models":[
		{"slug":"gpt-6-sol","display_name":"GPT-6 Sol","visibility":"list","priority":1,"context_window":272000},
		{"slug":"gpt-6-luna","display_name":"GPT-6 Luna","visibility":"list","priority":2,"context_window":272000}]}`), 0o644)
	provider.ForgetAccounts()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if !strings.HasSuffix(r.URL.Path, "/responses") {
			w.WriteHeader(404)
			return
		}
		if asked != nil {
			*asked = append(*asked, modelOf(b))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			`data: {"type":"response.created","response":{"id":"r1","model":"`+modelOf(b)+`"}}`,
			`data: {"type":"response.output_text.delta","delta":"on it"}`,
			`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":11,"output_tokens":3}}}`))
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })
}

// Scene 1: nothing set for Codex's subagents. The luna subagent stays on
// the model its lead named; magpie relays it. Is its usage on the ledger?
func TestProbeSubagentRelayedUsage(t *testing.T) {
	var asked []string
	probeSetup(t, &asked)
	s := New()
	rec := codexAsks(s, "gpt-6-luna", "collab_spawn", `{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "on it") {
		t.Fatalf("subagent: %d %s", rec.Code, rec.Body.String())
	}
	recs := usage.Load(time.Time{})
	for _, r := range recs {
		t.Logf("ledger: model=%q kind=%q in=%d out=%d status=%d provider=%q", r.Model, r.Kind, r.Input, r.Output, r.Status, r.Provider)
	}
	found := false
	for _, r := range recs {
		if r.Model == "gpt-6-luna" && r.Input == 11 && r.Output == 3 {
			found = true
		}
	}
	if !found {
		t.Fatalf("no gpt-6-luna usage row (11 in, 3 out) in %d records", len(recs))
	}
}

// Scene 2: a model set for Codex's subagents. The luna ask is moved onto
// it (one of magpie's own Codex models); is its usage on the ledger?
func TestProbeSubagentMovedUsage(t *testing.T) {
	var asked []string
	probeSetup(t, &asked)
	if err := provider.SetCodexSubagentModel("codex/gpt-6-sol"); err != nil {
		t.Fatal(err)
	}
	s := New()
	rec := codexAsks(s, "gpt-6-luna", "collab_spawn", `{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "on it") {
		t.Fatalf("subagent: %d %s", rec.Code, rec.Body.String())
	}
	recs := usage.Load(time.Time{})
	for _, r := range recs {
		t.Logf("ledger: model=%q requested=%q kind=%q in=%d out=%d status=%d", r.Model, r.Requested, r.Kind, r.Input, r.Output, r.Status)
	}
	found := false
	for _, r := range recs {
		if r.Input == 11 && r.Output == 3 {
			found = true
		}
	}
	if !found {
		t.Fatalf("no usage row (11 in, 3 out) in %d records", len(recs))
	}
}
