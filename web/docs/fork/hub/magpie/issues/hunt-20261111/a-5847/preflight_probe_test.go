package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/tidwall/gjson"

	"github.com/yetone/magpie/internal/provider"
)

// The relay's preflight as the issue's A/B established it (#5847,
// Haihangyuan): 200 only when the request carries both the beta header
// claude-code-20250219 and a body metadata.user_id — the two features a
// request sent directly needs, whatever the client's own headers are.
func TestAnthropicRelayKeepsThePreflightFingerprint(t *testing.T) {
	fresh(t)
	var mu sync.Mutex
	var gotBeta, gotMetadata string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotBeta = r.Header.Get("anthropic-beta")
		gotMetadata = gjson.GetBytes(b, "metadata.user_id").String()
		mu.Unlock()
		if !strings.Contains(gotBeta, "claude-code-20250219") || gotMetadata == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":{"type":"<nil>","message":"A preflight check failed for this request. Please upgrade your Claude Code version."}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer up.Close()
	p := provider.Provider{ID: "relay", Name: "Relay", Key: "k", Models: []string{"m"}}
	p.Anthropic = up.URL
	if err := provider.Save(p); err != nil {
		t.Fatal(err)
	}
	body := `{"model":"m","max_tokens":16,"metadata":{"user_id":"user_abc_account_def_session_xyz"},"messages":[{"role":"user","content":"hi"}]}`
	r := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+Token)
	r.Header.Set("User-Agent", "curl/8.4.0")
	r.Header.Set("anthropic-beta", "claude-code-20250219")
	w := httptest.NewRecorder()
	New().Handler().ServeHTTP(w, r)
	mu.Lock()
	defer mu.Unlock()
	if w.Code != 200 {
		t.Fatalf("%d %s (the beta magpie sent: %q; the metadata magpie sent: %q)", w.Code, w.Body.String(), gotBeta, gotMetadata)
	}
}
