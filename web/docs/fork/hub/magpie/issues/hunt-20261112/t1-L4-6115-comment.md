Triage — I could not reproduce this at current `upstream/main` (`873b4987e`), and the propagation chain looks complete on every path your report touches. A probe through a routing group, with a Chat upstream that answers content and ends at `finish_reason: "length"`, in all three client tongues, streamed and whole:

| Client | What arrives | Probe asserts |
| --- | --- | --- |
| Chat (`/v1/chat/completions`, relayed as sent) | `finish_reason: "length"` in the final chunk and in the whole body | pass |
| Responses (`/v1/responses`, translated) | `response.completed` with `"status":"incomplete"` and `incomplete_details.reason: "max_output_tokens"` | pass |
| Messages (`/v1/messages`, translated) | `stop_reason: "max_tokens"` | pass |

The probe (drop it as `internal/gateway/zz_probe_test.go` on a checkout of `main` and `go test ./internal/gateway -run TestProbeLengthThroughGroup`):

```go
package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

func TestProbeLengthThroughGroup(t *testing.T) {
	fresh(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, sse(
			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"doc body"},"finish_reason":null}]}`,
			`data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":3200}}`,
			`data: [DONE]`))
	}))
	t.Cleanup(up.Close)
	provider.Save(provider.Provider{ID: "vk", Name: "VK", Key: "sk-vk", Models: []string{"ds"}, Chat: up.URL + "/v1"})
	provider.SaveGroup(provider.Group{ID: "dsauto", Name: "DS", Members: []string{"vk/ds"}})
	g := provider.GroupPrefix + "dsauto"
	code, body := post(t, "/v1/chat/completions", `{"model":"`+g+`","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if !strings.Contains(body, `"finish_reason":"length"`) {
		t.Errorf("chat stream lost length: %d %s", code, body)
	}
	code, body = post(t, "/v1/responses", `{"model":"`+g+`","input":"hi"}`)
	if !strings.Contains(body, `"status":"incomplete"`) || !strings.Contains(body, `max_output_tokens`) {
		t.Errorf("responses lost incomplete: %d %s", code, body)
	}
	code, body = post(t, "/v1/messages", `{"model":"`+g+`","max_tokens":1000,"messages":[{"role":"user","content":"hi"}]}`)
	if !strings.Contains(body, `"stop_reason":"max_tokens"`) {
		t.Errorf("messages lost max_tokens: %d %s", code, body)
	}
}
```

**Why I believe your build predates the behavior you'd need**: magpie 0.1.1978 was built 2026-10-29. The stop mapping has been bidirectional since the gateway's first commit (`stopFromChat`/`stopToChat` carry `length` straight through, `stopToAnthropic` writes `max_tokens`, the Responses builders write `status: "incomplete"` with `incomplete_details.reason: "max_output_tokens"`), and since then the length face got its own review in #2972 (landed 2026-11-05, after your build): a length cut that said *nothing* now fails the turn at once instead of passing as completed, while one that said something goes on with its `length` as it came — which is your case at ~3200 tokens of output.

**On your three asks as of current main**:

1. *Propagate finish_reason* — already true on every path I could exercise (table above), and your own usage rows agree magpie knows (`stop=length` is in them). If a client on **0.1.38xx or later** still shows a clean stop on a `stop=length` row, the loss is downstream of magpie — naming the client and its protocol would pinpoint the hop.
2. *Mark truncation in the log* — usage rows already carry `stop=length`; the Requests page reads it.
3. *Auto-retry another channel on length* — that one is a real design call I'd leave to @yetone: the tokens spent before the cut are billed on the member that answered, and #2972's review deliberately rejected asking again on a length cut so the budget doesn't burn twice. Retrying content-bearing cuts on another member would need a policy (resume-from-partial is not something the relayed byte stream supports).

**Not verified**: your Windows deployment and the specific relay channels (vkteleapi, qyopenai, opencode-zen-free) — the probe uses the repository's fakes; a client that still shows a clean stop on a later build would need its identity and protocol named to trace.
