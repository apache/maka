package gateway

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/provider"
)

// deepseekRefuseToolTurns answers as DeepSeek's Chat API does in thinking
// mode (checked against api.deepseek.com and a relay of it, October 2026): a
// tool call made since the user's last message that comes back without
// reasoning_content turns the whole request away, as does a reply to a tool
// result without it, while an empty one, another reply's, or one from before
// the user's last message missing are taken. A message that carries the
// thinking in both reasoning_content and reasoning is turned away as a
// duplicate field, which is how it reads the two spellings as one field.
func deepseekRefuseToolTurns(body []byte) (int, string) {
	var q struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	json.Unmarshal(body, &q)
	last := -1
	for i, m := range q.Messages {
		if string(m["role"]) == `"user"` {
			last = i
		}
	}
	afterTool := false
	for _, m := range q.Messages[last+1:] {
		if _, both := m["reasoning"]; both && m["reasoning_content"] != nil {
			return 400, `{"error":{"code":"json_parse_error","message":"Failed to deserialize the JSON body into the target type: duplicate field ` + "`reasoning`" + `","param":null,"type":"invalid_request_error"}}`
		}
		// a reply to a tool result too (checked 2026-10-12, #1822)
		if string(m["role"]) == `"assistant"` && (len(m["tool_calls"]) > 0 || afterTool) && m["reasoning_content"] == nil {
			return 400, `{"error":{"message":"The ` + "`reasoning_content`" + ` in the thinking mode must be passed back to the API. (request_id: 06048513-d7c7-4cdf-9998-47bfc20484e6)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`
		}
		afterTool = string(m["role"]) == `"tool"`
	}
	return 0, ""
}

const timeCall = `{"id":"call_1","type":"function","function":{"name":"get_time","arguments":"{}"}}`

// the issue's request: OpenCode continuing a turn whose tool calls it has
// no thinking for (one another model made), and one that has its own
const toolTurnsNoReasoning = `{"model":"%s","stream":false,"tools":[{"type":"function","function":{"name":"get_time","parameters":{"type":"object","properties":{}}}}],"messages":[
	{"role":"user","content":"hi"},
	{"role":"assistant","content":"Hello!"},
	{"role":"user","content":"what time is it? twice"},
	{"role":"assistant","content":null,"tool_calls":[` + timeCall + `]},
	{"role":"tool","tool_call_id":"call_1","content":"12:00"},
	{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more."},
	{"role":"tool","tool_call_id":"call_2","content":"12:01"},
	{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning":"OpenRouter's field."},
	{"role":"tool","tool_call_id":"call_3","content":"12:02"}]}`

func chatProvider(t *testing.T, up string, p provider.Provider) {
	t.Helper()
	p.Name, p.Key, p.Chat = p.ID, "k", up+"/v1"
	if err := provider.Save(p); err != nil {
		t.Fatal(err)
	}
}

// A Chat request relayed as it came to a DeepSeek model, here behind
// OpenCode Go whose host doesn't say DeepSeek, gives every tool call
// without reasoning_content one, so DeepSeek takes it (#1462). The
// thinking a turn has keeps it, one sent in another field goes there too,
// and every other message goes as it was sent.
func TestChatToolTurnWithoutReasoningRelayed(t *testing.T) {
	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: deepseekRefuseToolTurns}
	up := setup(t, provider.Chat, f)
	chatProvider(t, up.URL, provider.Provider{ID: "go", Models: []string{"deepseek-v4.1-flash", "glm-5.2"}})
	srv := New()
	for _, model := range []string{"go/deepseek-v4.1-flash", "group/flash"} {
		if model == "group/flash" {
			if err := provider.SaveGroup(provider.Group{ID: "flash", Name: "Flash", Members: []string{"go/deepseek-v4.1-flash"}, Routing: provider.Ordered}); err != nil {
				t.Fatal(err)
			}
		}
		f.calls = 0
		code, body := postTo(t, srv, "/v1/chat/completions", strings.Replace(toolTurnsNoReasoning, "%s", model, 1))
		if code != 200 || f.calls != 1 {
			t.Fatalf("%s: %d after %d calls: %s", model, code, f.calls, body)
		}
		ms := sentMessages(t, f.got)
		sameJSON(t, ms[1], `{"role":"assistant","content":"Hello!"}`)
		sameJSON(t, ms[3], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`],"reasoning_content":" "}`)
		sameJSON(t, ms[5], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_2","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"Once more."}`)
		sameJSON(t, ms[7], `{"role":"assistant","content":null,"tool_calls":[{"id":"call_3","type":"function","function":{"name":"get_time","arguments":"{}"}}],"reasoning_content":"OpenRouter's field."}`)
		sameJSON(t, ms[4], `{"role":"tool","tool_call_id":"call_1","content":"12:00"}`)
	}

	// another model on the same relay is sent the messages as they came
	f.refuse = nil
	code, body := postTo(t, srv, "/v1/chat/completions", strings.Replace(toolTurnsNoReasoning, "%s", "go/glm-5.2", 1))
	if code != 200 {
		t.Fatalf("glm: %d: %s", code, body)
	}
	if strings.Contains(string(f.got), `"reasoning_content":" "`) || strings.Count(string(f.got), "reasoning_content") != 1 {
		t.Errorf("glm was given reasoning: %s", f.got)
	}
}

// A reply that carries its thinking in both of DeepSeek's spellings, with no
// tool call in the request at all, goes with reasoning_content alone: the
// upstream reads the two as one field and would turn the request away as a
// duplicate field otherwise.
func TestChatBothReasoningSpellingsRelayed(t *testing.T) {
	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: deepseekRefuseToolTurns}
	up := setup(t, provider.Chat, f)
	chatProvider(t, up.URL, provider.Provider{ID: "ds", Models: []string{"deepseek-v4.1-flash"}})
	code, body := postTo(t, New(), "/v1/chat/completions", `{"model":"ds/deepseek-v4.1-flash","stream":false,"messages":[
		{"role":"user","content":"hi"},
		{"role":"assistant","content":"Hello!","reasoning":"the thinking","reasoning_content":"the thinking"},
		{"role":"user","content":"again"}]}`)
	if code != 200 || f.calls != 1 {
		t.Fatalf("%d after %d calls: %s", code, f.calls, body)
	}
	sameJSON(t, sentMessages(t, f.got)[1], `{"role":"assistant","content":"Hello!","reasoning_content":"the thinking"}`)
}

// Mistral, which turns reasoning_content away (#494), is given none for a
// tool call without thinking.
func TestChatToolTurnWithoutReasoningNotForMistral(t *testing.T) {
	f := &fake{t: t, reply: chatWholeOK, ctype: "application/json", refuse: mistralRefuseMessages}
	up := setup(t, provider.Chat, f)
	chatProvider(t, up.URL, provider.Provider{ID: "mistral", Preset: "mistral", Models: []string{"mistral-medium-3.5"}})
	code, body := postTo(t, New(), "/v1/chat/completions", `{"model":"mistral/mistral-medium-3.5","stream":false,"messages":[
		{"role":"user","content":"what time is it?"},
		{"role":"assistant","content":null,"tool_calls":[`+timeCall+`]},
		{"role":"tool","tool_call_id":"call_1","content":"12:00"}]}`)
	if code != 200 || f.calls != 1 {
		t.Fatalf("%d after %d calls: %s", code, f.calls, body)
	}
	sameJSON(t, sentMessages(t, f.got)[1], `{"role":"assistant","content":null,"tool_calls":[`+timeCall+`]}`)
}

// Translated to Chat (Codex on Responses, here a turn whose call came with
// no reasoning item: another model's), a DeepSeek model's tool call goes
// with reasoning_content all the same (#1462); a reply with no tool calls
// goes without.
func TestTranslatedToolTurnWithoutReasoning(t *testing.T) {
	f := &fake{t: t, refuse: deepseekRefuseToolTurns, reply: `data: {"id":"c1","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"It is 12:00."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}` + "\n\ndata: [DONE]\n\n"}
	up := setup(t, provider.Chat, f)
	chatProvider(t, up.URL, provider.Provider{ID: "ds", Models: []string{"deepseek-v4.1-flash"}})
	code, body := postTo(t, New(), "/v1/responses", `{"model":"ds/deepseek-v4.1-flash","stream":false,"tools":[{"type":"function","name":"get_time","parameters":{"type":"object","properties":{}}}],"input":[
		{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
		{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello!"}]},
		{"type":"message","role":"user","content":[{"type":"input_text","text":"what time is it?"}]},
		{"type":"function_call","call_id":"call_1","name":"get_time","arguments":"{}"},
		{"type":"function_call_output","call_id":"call_1","output":"12:00"}]}`)
	if code != 200 || f.calls != 1 {
		t.Fatalf("%d after %d calls: %s", code, f.calls, body)
	}
	ms := sentMessages(t, f.got)
	var reply, call map[string]any
	for _, raw := range ms {
		var m map[string]any
		json.Unmarshal(raw, &m)
		if m["role"] != "assistant" {
			continue
		}
		if m["tool_calls"] != nil {
			call = m
		} else {
			reply = m
		}
	}
	if call == nil || call["reasoning_content"] != " " {
		t.Errorf("the tool call went without reasoning: %s", f.got)
	}
	if _, ok := reply["reasoning_content"]; reply == nil || ok {
		t.Errorf("the reply was given reasoning: %s", f.got)
	}
}
