package gateway

// A translated Anthropic stream (a client on /v1/messages, a Chat upstream)
// ends with a message_delta carrying the real output_tokens and the stop
// reason before message_stop (#5818, yuhang0521): message_start's
// output_tokens is the placeholder 0, so a stream that skips the delta
// leaves the client — and magpie's own ledger — counting the turn as zero
// out. The delta is written by the encoder's finish alone; the probe walks
// the shapes an upstream's stream can end in (a normal [DONE], a bare end
// of body, a cut mid-event) and demands the delta in each.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func mdChunk(id, text string) string {
	return `data: {"id":"` + id + `","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"` + text + `"}}]}` + "\n\n"
}

func mdStop(id, reason string) string {
	return `data: {"id":"` + id + `","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"` + reason + `"}],"usage":{"prompt_tokens":9,"completion_tokens":16,"total_tokens":25}}` + "\n\n"
}

// eventsOf asks the gateway the reporter's request and returns the stream's
// event types in order.
func eventsOf(t *testing.T, s *Server, body string) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("answered %d: %s", rec.Code, rec.Body.String()[:min(400, rec.Body.Len())])
	}
	var out []string
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if after, ok := strings.CutPrefix(line, "event: "); ok {
			out = append(out, strings.TrimSpace(after))
		}
	}
	return out
}

func mdCount(events []string, name string) int {
	n := 0
	for _, e := range events {
		if e == name {
			n++
		}
	}
	return n
}

func TestTranslatedAnthropicStreamSaysMessageDelta(t *testing.T) {
	fresh(t)
	for _, c := range []struct {
		name string
		sse  string // what the Chat upstream streams back
	}{
		{"a normal [DONE] end", mdChunk("c1", "ok") + mdStop("c1", "stop") + "data: [DONE]\n\n"},
		{"a bare end of body", mdChunk("c1", "ok") + mdStop("c1", "stop")},
		{"the role chunk alone then [DONE]", `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}],"usage":{"prompt_tokens":9,"completion_tokens":16}}` + "\n\n" + "data: [DONE]\n\n"},
		{"no finish_reason, bare [DONE]", mdChunk("c1", "ok") + "data: [DONE]\n\n"},
		{"no finish_reason, bare end", mdChunk("c1", "ok")},
		{"stop chunk without usage", `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n" + "data: [DONE]\n\n"},
		{"thinking deltas then stop", `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"hmm"}}]}` + "\n\n" + mdChunk("c1", "ok") + mdStop("c1", "stop") + "data: [DONE]\n\n"},
		{"cut mid-chunk json", mdChunk("c1", "ok") + `data: {"id":"c1","object":"chat.completion.`},
		{"stop then [DONE] twice", mdChunk("c1", "ok") + mdStop("c1", "stop") + "data: [DONE]\n\n" + mdStop("c1", "stop") + "data: [DONE]\n\n"},
		{"CRLF line endings", strings.ReplaceAll(mdChunk("c1", "ok")+mdStop("c1", "stop")+"data: [DONE]\n\n", "\n", "\r\n")},
		{"usage chunk after [DONE]-like blank", mdChunk("c1", "ok") + mdStop("c1", "stop") + "\n" + "data: [DONE]\n\n"},
		{"event: lines with CRLF and spaces", strings.ReplaceAll("event: message_stop\r\n", "\n", "\r\n")},
	} {
		t.Run(c.name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.(http.Flusher).Flush()
				w.Write([]byte(c.sse))
			}))
			defer up.Close()
			if err := provider.Save(provider.Provider{ID: "a", Name: "A", Key: "k", Models: []string{"m1"}, Chat: up.URL + "/v1"}); err != nil {
				t.Fatal(err)
			}
			events := eventsOf(t, New(), `{"model":"a/m1","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"reply with one word: ok"}]}`)
			if got := mdCount(events, "message_delta"); got != 1 {
				t.Fatalf("message_delta x%d, want 1; events: %v", got, events)
			}
			if mdCount(events, "message_stop") != 1 {
				t.Fatalf("message_stop missing: %v", events)
			}
		})
	}
}
