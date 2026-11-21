package gateway

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// reporter5439Stream is the stream of yetone/magpie#5439's report: a
// thinking block, then an empty text block whose start the relay's
// text-calls filter holds while nothing of it has gone on, released when
// the block's first words arrive. Its frames are the shape a Messages
// upstream streams.
const reporter5439Stream = `event: message_start
data: {"type":"message_start","message":{"id":"msg_5439","type":"message","role":"assistant","model":"relay-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}

`

// reporter5439Chunks is the stream the way an upstream that flushes each
// SSE line on its own reaches the relay: the held block's event line, its
// data, the next event's line and its data each arrive in a read of their
// own. On the line-gathered reader (before #4868) the lone event lines went
// out bare and the held start went out without its name, so the client read
// one event named by the last bare line carrying the start's data — the
// mismatch #5439 reports.
func reporter5439Chunks() []string {
	prefix := reporter5439Stream[:strings.Index(reporter5439Stream, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1")]
	return []string{
		prefix,
		"event: content_block_start\n",
		"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
		"event: content_block_delta\n",
		"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
		reporter5439Stream[strings.LastIndex(reporter5439Stream, "event: content_block_stop"):],
	}
}

// The reply #5439 reports, read from whole events whatever boundaries the
// upstream wrote: every frame the client sees names itself as its data
// says, and the held text block's start reaches the client as a
// content_block_start.
func TestReporter5439StreamKeepsNames(t *testing.T) {
	setup(t, provider.Anthropic, &fake{t: t})
	chunks := reporter5439Chunks()
	s := New()
	s.client = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Header:     http.Header{"Content-Type": {"text/event-stream"}},
			Body:       &sseChunkBody{chunks: append([]string(nil), chunks...)},
			Request:    r,
		}, nil
	})}
	const ask = `{"model":"fake/m1","max_tokens":256,"stream":true,` +
		`"tools":[{"name":"Bash","description":"Run a shell command","input_schema":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}],` +
		`"messages":[{"role":"user","content":"hi"}]}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages?beta=true", strings.NewReader(ask))
	req.Header.Set("anthropic-version", "2023-06-01")
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	frames := readAnthropicSSE(t, rec.Body.String())
	sawTextStart := false
	for i, f := range frames {
		if f.event != f.chunk.Type {
			t.Fatalf("frame %d says event %q but data type %q", i, f.event, f.chunk.Type)
		}
		if f.event == "content_block_start" && f.chunk.Index == 1 && f.chunk.ContentBlock.Type == "text" {
			sawTextStart = true
		}
	}
	if !sawTextStart {
		t.Fatalf("the held text block's start never reached the client as a content_block_start: %s", rec.Body.String())
	}
}
