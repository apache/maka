package gateway

import (
	"bytes"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// Probe for #5066: a request whose messages[2] is an assistant turn with
// reasoning_content (the reporter's 422 extra_forbidden at
// body.messages[2].assistant.reasoning_content) must not reach a Mistral
// upstream with the field: to the mistral preset it goes as the thinking
// part in the first ask, and to any other Chat upstream that refuses it
// the retry leaves it out. Both pass on the tree with #494 in, so the
// reporter's build predates v0.1.616.
func TestProbe5066Streamed(t *testing.T) {
	const req = `{"model":"mistral-medium-latest","stream":true,"messages":[
		{"role":"user","content":"hi"},
		{"role":"assistant","content":"hello!"},
		{"role":"user","content":"你好啊哦"},
		{"role":"assistant","content":"你好！很高兴见到你。","reasoning_content":"The user just said \"你好啊哦\" (hello). This is a casual greeting. I should respond naturally and briefly in Chinese, per preferences. No tools needed."},
		{"role":"user","content":"再讲一个笑话"}]}`

	t.Run("mistral preset converts it in the first ask", func(t *testing.T) {
		f := &fake{t: t, reply: sse(`data: {"id":"c1","object":"chat.completion","model":"m1","choices":[{"index":0,"delta":{"content":"ok"}}]}`, `data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}`, `data: [DONE]`), ctype: "application/json", refuse: mistralRefuseMessages}
		up := setup(t, provider.Chat, f)
		if err := provider.Save(provider.Provider{ID: "fake", Name: "Mistral", Key: "k", Models: []string{"mistral-medium-latest"},
			Preset: "mistral", Chat: up.URL + "/v1"}); err != nil {
			t.Fatal(err)
		}
		srv := New()
		code, body := postTo(t, srv, "/v1/chat/completions", req)
		if code != 200 || f.calls != 1 {
			t.Fatalf("%d after %d calls: %s", code, f.calls, body)
		}
		ms := sentMessages(t, f.got)
		for _, m := range ms {
			if bytes.Contains(m, []byte("reasoning_content")) {
				t.Errorf("reasoning_content reached the upstream: %s", f.got)
			}
		}
		sameJSON(t, ms[3], `{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"The user just said \"你好啊哦\" (hello). This is a casual greeting. I should respond naturally and briefly in Chinese, per preferences. No tools needed."}]},{"type":"text","text":"你好！很高兴见到你。"}]}`)
	})

	t.Run("other chat upstream refused is asked again without it", func(t *testing.T) {
		f := &fake{t: t, reply: sse(`data: {"id":"c1","object":"chat.completion","model":"m1","choices":[{"index":0,"delta":{"content":"ok"}}]}`, `data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}`, `data: [DONE]`), ctype: "application/json", refuse: mistralRefuseMessages}
		up := setup(t, provider.Chat, f)
		if err := provider.Save(provider.Provider{ID: "fake", Name: "Mistral relay", Key: "k", Models: []string{"mistral-medium-latest"},
			Chat: up.URL + "/v1"}); err != nil {
			t.Fatal(err)
		}
		srv := New()
		code, body := postTo(t, srv, "/v1/chat/completions", req)
		if code != 200 || f.calls != 2 {
			t.Fatalf("%d after %d calls: %s", code, f.calls, body)
		}
		if bytes.Contains(f.got, []byte("reasoning_content")) {
			t.Errorf("the retry still sent reasoning_content: %s", f.got)
		}
		f.calls = 0
		if code, body := postTo(t, srv, "/v1/chat/completions", req); code != 200 || f.calls != 1 {
			t.Fatalf("learned: %d after %d calls: %s", code, f.calls, body)
		}
	})
}
