package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// Suspect 1 (hunt35-B ①), full chain through buildChat: translated path,
// an image user, a silent assistant turn, an orphaned tool result. What
// message sequence reaches the upstream?
func TestProbe36bSuspect1FourConditions(t *testing.T) {
	r := &Request{Messages: []Message{
		{Role: "user", Parts: []Part{{Kind: Text, Text: "看图"}, {Kind: Image, URL: "data:image/png;base64,iVBORw0KGgo="}}},
		{Role: "assistant", Parts: []Part{{Kind: Thinking, Text: "hmm", Signature: "sig"}}},
		{Role: "user", Parts: []Part{result("gone", "孤儿结果"), {Kind: Text, Text: "继续"}}},
	}}
	body := buildChat(r, "m1", "api.deepseek.com", false)
	var q struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(body, &q); err != nil {
		t.Fatal(err)
	}
	var roles []string
	for _, m := range q.Messages {
		role, _ := m["role"].(string)
		roles = append(roles, role)
	}
	t.Logf("suspect1 roles: %v", strings.Join(roles, " "))
	for i := 1; i < len(roles); i++ {
		if roles[i] == "user" && roles[i-1] == "user" {
			t.Logf("suspect1: two consecutive users at %d", i)
		}
	}
	// also: the same shape without the silent turn
	r2 := &Request{Messages: []Message{
		{Role: "user", Parts: []Part{result("gone", "孤儿结果"), {Kind: Text, Text: "继续"}}},
	}}
	body2 := buildChat(r2, "m1", "api.deepseek.com", false)
	var q2 struct {
		Messages []map[string]any `json:"messages"`
	}
	json.Unmarshal(body2, &q2)
	var roles2 []string
	for _, m := range q2.Messages {
		role, _ := m["role"].(string)
		roles2 = append(roles2, role)
	}
	t.Logf("suspect1 minimal (orphan+text, no image, no silent): %v", strings.Join(roles2, " "))
}

// Suspect 2 (hunt35-B ②), full chain: a relayed Chat body, one turn's
// calls split over two assistant messages, all ids empty, results in
// order. What ids do the results get?
func TestProbe36bSuspect2ChatCallIDsSplitTurns(t *testing.T) {
	body := `{"model":"m1","messages":[` +
		`{"role":"assistant","content":null,"tool_calls":[{"id":"","type":"function","function":{"name":"a","arguments":"{}"}}]},` +
		`{"role":"assistant","content":null,"tool_calls":[{"id":"","type":"function","function":{"name":"b","arguments":"{}"}}]},` +
		`{"role":"tool","tool_call_id":"","content":"结果-a"},` +
		`{"role":"tool","tool_call_id":"","content":"结果-b"}]}`
	out := chatCallIDs([]byte(body))
	var q struct {
		Messages []struct {
			Role      string `json:"role"`
			ToolCalls []struct {
				ID       string `json:"id"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tool_calls"`
			ToolCallID string `json:"tool_call_id"`
			Content    string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(out, &q); err != nil {
		t.Fatal(err)
	}
	for _, m := range q.Messages {
		if m.Role == "assistant" {
			for _, c := range m.ToolCalls {
				t.Logf("call %s id=%s", c.Function.Name, c.ID)
			}
		}
		if m.Role == "tool" {
			t.Logf("result %q tool_call_id=%s", m.Content, m.ToolCallID)
		}
	}
}

// Suspect 3 (hunt35-B ③): is there a host where inlineThink and a
// prefill mode both apply?
func TestProbe36bSuspect3InlineThinkPrefillDisjoint(t *testing.T) {
	for _, host := range []string{"api.minimax.io", "api.minimaxi.com", "api.deepseek.com", "api.moonshot.cn", "localhost:9999", "127.0.0.1:8123"} {
		for _, model := range []string{"MiniMax-Text-01", "deepseek-v4", "kimi-k3", "abab7"} {
			inline := strings.HasSuffix(host, "minimax.io") || strings.HasSuffix(host, "minimaxi.com")
			prefill := chatPrefill(host, model)
			if inline && prefill != "" {
				t.Errorf("host %s model %s: inlineThink and prefill %q both apply", host, model, prefill)
			}
		}
	}
}
