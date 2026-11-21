package gateway

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// probe fake: records session headers, UA, trace, and the whole body of
// every request, so a multi-turn conversation's bytes can be compared.
type probe4950 struct {
	mu     sync.Mutex
	heads  []map[string]string
	bodies []string
}

func (f *probe4950) RoundTrip(r *http.Request) (*http.Response, error) {
	var b []byte
	if r.Body != nil {
		b, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}
	hm := map[string]string{}
	for k, vs := range r.Header {
		hm[strings.ToLower(k)] = strings.Join(vs, ",")
	}
	f.mu.Lock()
	f.heads = append(f.heads, hm)
	f.bodies = append(f.bodies, string(b))
	f.mu.Unlock()
	h := http.Header{"Content-Type": {"application/json"}}
	reply := `{"id":"resp_1","object":"response","status":"completed","model":"glm-5.3","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`
	return &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(strings.NewReader(reply)), Request: r}, nil
}

// a bare /v1/chat/completions caller with no session headers, three turns
// of one conversation: what session, UA and trace does each turn carry,
// and does turn 2's body carry turn 1's bytes as its prefix?
func TestProbe4950BareCallerTurns(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if err := provider.Save(provider.Provider{ID: "ocgo", Name: "OpenCode Go", Key: "k", Responses: "https://opencode.ai/zen/go/v1", Models: []string{"glm-5.3"}}); err != nil {
		t.Fatal(err)
	}
	f := &probe4950{}
	s := New()
	s.client = &http.Client{Transport: f}
	turn := func(body string) {
		t.Helper()
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("User-Agent", "Go-http-client/2.0")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	}
	tools := `,"tools":[{"type":"function","function":{"name":"exec_command","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}}]`
	turn(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"list the files"}]` + tools + `}`)
	turn(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"list the files"},{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"ls\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"a.txt"}]` + tools + `}`)
	turn(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"list the files"},{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"ls\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"a.txt"},{"role":"assistant","content":"here they are"},{"role":"user","content":"thanks"}]` + tools + `}`)
	// every header, turn over turn: what changes between turns?
	for i := 1; i < len(f.heads); i++ {
		var changed, gone, added []string
		for k, v := range f.heads[i-1] {
			w, ok := f.heads[i][k]
			if !ok {
				gone = append(gone, k)
			} else if w != v && !stableHeader(k, v, w) {
				changed = append(changed, k+"="+short(k, v)+"->"+short(k, w))
			}
		}
		for k := range f.heads[i] {
			if _, ok := f.heads[i-1][k]; !ok {
				added = append(added, k)
			}
		}
		t.Logf("turn %d vs %d: changed=[%s] gone=[%s] added=[%s]", i+1, i, strings.Join(changed, " "), strings.Join(gone, " "), strings.Join(added, " "))
	}
	if f.heads[0]["x-opencode-session"] != f.heads[1]["x-opencode-session"] || f.heads[1]["x-opencode-session"] != f.heads[2]["x-opencode-session"] {
		t.Errorf("session drifts across turns: %q %q %q", f.heads[0]["x-opencode-session"], f.heads[1]["x-opencode-session"], f.heads[2]["x-opencode-session"])
	}
}

// stableHeader says whether a header's turn-over-turn change is the
// contract's own: a new span on the same trace.
func stableHeader(k, a, b string) bool {
	switch k {
	case "b3", "traceparent":
		ta := strings.SplitN(a, "-", 2)
		tb := strings.SplitN(b, "-", 2)
		return len(ta) == 2 && len(tb) == 2 && ta[0] == tb[0]
	}
	return false
}

func short(k, v string) string {
	if k == "authorization" || k == "x-api-key" {
		return "<key>"
	}
	if len(v) > 40 {
		return v[:40] + "..."
	}
	return v
}

// many parallel conversations between one conversation's turns: does its
// session value survive (the LRU says 1000)?
func TestProbe4950LRUPressure(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if err := provider.Save(provider.Provider{ID: "ocgo", Name: "OpenCode Go", Key: "k", Responses: "https://opencode.ai/zen/go/v1", Models: []string{"glm-5.3"}}); err != nil {
		t.Fatal(err)
	}
	f := &probe4950{}
	s := New()
	s.client = &http.Client{Transport: f}
	post := func(body string) {
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("User-Agent", "Go-http-client/2.0")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	}
	turn := `{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"conv X turn"}]}`
	post(strings.Replace(turn, "conv X", "conv main", 1))
	for i := 0; i < 1200; i++ {
		post(strings.Replace(turn, "conv X", fmt.Sprintf("conv other %d %s", i, strings.Repeat("x", 24)), 1))
	}
	post(strings.Replace(turn, "conv X", "conv main, turn 2", 1))
	if f.heads[0]["x-opencode-session"] != f.heads[len(f.heads)-1]["x-opencode-session"] {
		t.Errorf("session lost under LRU pressure: first %q last %q", f.heads[0]["x-opencode-session"], f.heads[len(f.heads)-1]["x-opencode-session"])
	} else {
		t.Logf("session survived 1200 interleaved conversations: %s", f.heads[0]["x-opencode-session"])
	}
}

// two conversations whose FIRST user message is the same template text
// (the reporter's agent, and #3938's parallel conversations sharing one
// conv): do they share the same upstream session?
func TestProbe4950SameFirstMessage(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if err := provider.Save(provider.Provider{ID: "ocgo", Name: "OpenCode Go", Key: "k", Responses: "https://opencode.ai/zen/go/v1", Models: []string{"glm-5.3"}}); err != nil {
		t.Fatal(err)
	}
	f := &probe4950{}
	s := New()
	s.client = &http.Client{Transport: f}
	post := func(body string) {
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("User-Agent", "Go-http-client/2.0")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	}
	env := `<environment_context><cwd>/w</cwd></environment_context>`
	// conversation A: template first message, then its own turns
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + ` task alpha"}]}`)
	// 3 other conversations, same template opener, different tasks
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + ` task beta"}]}`)
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + ` task gamma"}]}`)
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + ` task delta"}]}`)
	// conversation A's second turn
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + ` task alpha"},{"role":"assistant","content":"done"},{"role":"user","content":"go on"}]}`)
	sess := []string{f.heads[0]["x-opencode-session"], f.heads[1]["x-opencode-session"], f.heads[2]["x-opencode-session"], f.heads[3]["x-opencode-session"], f.heads[4]["x-opencode-session"]}
	t.Logf("sessions: alpha=%s beta=%s gamma=%s delta=%s alpha-turn2=%s", sess[0][:20], sess[1][:20], sess[2][:20], sess[3][:20], sess[4][:20])
	if sess[0] == sess[1] {
		t.Errorf("two conversations with the same template opener SHARE one upstream session (alpha %s == beta %s)", sess[0], sess[1])
	}
	if sess[0] != sess[4] {
		t.Errorf("conversation A's own turns drifted: %s vs %s", sess[0], sess[4])
	}
}

// two conversations whose first user message is byte for byte the same
// (#3938's parallel conversations sharing one conv): one upstream session?
func TestProbe4950IdenticalFirstMessage(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	if err := provider.Save(provider.Provider{ID: "ocgo", Name: "OpenCode Go", Key: "k", Responses: "https://opencode.ai/zen/go/v1", Models: []string{"glm-5.3"}}); err != nil {
		t.Fatal(err)
	}
	f := &probe4950{}
	s := New()
	s.client = &http.Client{Transport: f}
	post := func(body string) {
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
		req.Header.Set("User-Agent", "Go-http-client/2.0")
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%d %s", rec.Code, rec.Body)
		}
	}
	env := `<environment_context><cwd>/w</cwd></environment_context>`
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + `"}]}`)
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + `"}]}`)
	post(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + `"},{"role":"assistant","content":"conv A said hi"},{"role":"user","content":"conv A: go on"}]}`)
	sess := []string{f.heads[0]["x-opencode-session"], f.heads[1]["x-opencode-session"], f.heads[2]["x-opencode-session"]}
	conv := []string{}
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + `"}]}`))
		conv = append(conv, conversationID(req.Header, []byte(`{"model":"ocgo/glm-5.3","messages":[{"role":"user","content":"` + env + `"}]}`)))
	}
	t.Logf("conv of the identical first messages: %s", conv[0])
	t.Logf("sessions: first=%s second=%s convA-turn2=%s", sess[0][:20], sess[1][:20], sess[2][:20])
	if sess[0] == sess[1] {
		t.Errorf("two conversations with an IDENTICAL first user message share one upstream session (%s)", sess[0])
	}
}
