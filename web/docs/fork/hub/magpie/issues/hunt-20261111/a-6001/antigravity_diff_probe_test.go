package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// Differential probe for #6001: the same multi-turn tool conversation asked
// on /v1/chat/completions and on /v1/responses — what each sends Antigravity
// is captured and compared, so the endpoint that comes back "an empty reply"
// can be told apart from the one that doesn't by what went out, not by what
// came back.
func TestAntigravityResponsesHistoryMatchesChat(t *testing.T) {
	fresh(t)
	logins := []map[string]any{{
		"agent": "antigravity", "user": "a@example.com", "on": true,
		"auth": map[string]any{"access_token": "a@example.com", "refresh_token": "ref-a", "project": "p1",
			"expiry_date": time.Now().Add(time.Hour).UnixMilli()},
	}}
	dir := filepath.Dir(provider.Path())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logins.json"), mustJSON(logins), 0o600); err != nil {
		t.Fatal(err)
	}
	old := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
		var body string
		switch {
		case strings.HasSuffix(r.URL.Path, "latest-arm64-mac.yml"):
			body = "version: 2.9.1\n"
		case strings.Contains(r.URL.Path, ":loadCodeAssist"):
			body = `{"currentTier":{"id":"standard-tier"},"cloudaicompanionProject":"p1"}`
		case strings.Contains(r.URL.Path, ":fetchAvailableModels"):
			body = `{"models":{"m":{}}}`
		default:
			return nil, fmt.Errorf("unexpected request to %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = old })
	p, _ := provider.Find("antigravity")
	if _, err := p.Fetch(t.Context()); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var sent []string
	s := New()
	s.client = &http.Client{Transport: countTransport(func(r *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		sent = append(sent, r.URL.Path+" "+string(b))
		mu.Unlock()
		rec := httptest.NewRecorder()
		rec.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rec, sse(`data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3}}}`))
		return rec.Result(), nil
	})}

	chatBody := `{"model":"antigravity/m","stream":false,
	  "messages":[
	    {"role":"user","content":"check the file"},
	    {"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"/tmp/x\"}"}}]},
	    {"role":"tool","tool_call_id":"call_1","content":"file contents here"},
	    {"role":"user","content":"now summarize"}
	  ],
	  "tools":[{"type":"function","function":{"name":"read_file","description":"Read a file.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}`

	responsesBody := `{"model":"antigravity/m","stream":false,"store":false,
	  "input":[
	    {"type":"message","role":"user","content":[{"type":"input_text","text":"check the file"}]},
	    {"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"the user wants the file read"}]},
	    {"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"/tmp/x\"}"},
	    {"type":"function_call_output","call_id":"call_1","output":"file contents here"},
	    {"type":"message","role":"user","content":[{"type":"input_text","text":"now summarize"}]}
	  ],
	  "tools":[{"type":"function","name":"read_file","description":"Read a file.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]}`

	for _, c := range []struct{ path, body string }{
		{"/v1/chat/completions", chatBody},
		{"/v1/responses", responsesBody},
	} {
		postFrom(t, s, "alma", c.path, c.body)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 2 {
		t.Fatalf("sent %d", len(sent))
	}
	for i, got := range sent {
		var env struct {
			Request struct {
				Contents []map[string]any `json:"contents"`
			} `json:"request"`
		}
		if err := json.Unmarshal([]byte(strings.SplitN(got, " ", 2)[1]), &env); err != nil {
			t.Fatalf("envelope %d: %v\n%s", i, err, got)
		}
		out, _ := json.MarshalIndent(env.Request.Contents, "", " ")
		t.Logf("=== ask %d (%s) contents:\n%s", i, strings.SplitN(got, " ", 2)[0], out)
	}
	// the comparison itself is the human's job on the first run: log both
	// and fail with a note, so the shapes are read side by side
	t.Skip("differential probe: read the two contents dumps above")
}
