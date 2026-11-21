package gateway

// Boundary probe for #3615 verification (not part of the patch): pins the
// reset conditions of toolLoopUnansweredOf directly and records the wait
// boundary against tip's allWaits exemption.
import (
	"encoding/json"
	"testing"
)

func probeCalls(name, args string, n int) Message {
	return Message{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "call_x", Name: name, Args: json.RawMessage(args)}}}
}

func TestProbeUnansweredResets(t *testing.T) {
	args := `{"cmd":"ls"}`
	build := func(withResultAfter int, wait bool) []Message {
		name := "exec_command"
		if wait {
			name = "clock__sleep"
		}
		msgs := []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}}}
		for i := 0; i < 10; i++ {
			msgs = append(msgs, probeCalls(name, args, i))
			if withResultAfter == i {
				msgs = append(msgs, Message{Role: "user", Parts: []Part{{Kind: ToolResult, Text: "done"}}})
			}
		}
		return msgs
	}

	if _, ok := toolLoopUnansweredOf(build(4, false)); ok {
		t.Fatalf("a result after turn 4 did not reset the unanswered count")
	}
	if _, ok := toolLoopUnansweredOf(build(-1, false)); !ok {
		t.Fatalf("10 answerless turns of one call were not stopped")
	}
	if _, ok := toolLoopUnansweredOf(build(-1, true)); !ok {
		t.Fatalf("10 answerless turns of clock__sleep were not stopped (wait exemption does not cover the unanswered shape)")
	}

	// differing names alternate: never one call 8 times
	alt := []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}}}
	for i := 0; i < 10; i++ {
		n := "ask_a"
		if i%2 == 1 {
			n = "ask_b"
		}
		alt = append(alt, probeCalls(n, args, i))
	}
	if _, ok := toolLoopUnansweredOf(alt); ok {
		t.Fatalf("alternating names were judged one looping call")
	}

	// differing ids, same name and args: still the same call
	same := []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}}}
	for i := 0; i < 10; i++ {
		same = append(same, Message{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "call_a", Name: "exec_command", Args: json.RawMessage(args)}}})
	}
	if _, ok := toolLoopUnansweredOf(same); !ok {
		t.Fatalf("differing call ids were not ignored")
	}

	// a reasoning turn between the calls does not reset
	withThink := []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}}}
	for i := 0; i < 10; i++ {
		withThink = append(withThink, probeCalls("exec_command", args, i))
		if i == 3 {
			withThink = append(withThink, Message{Role: "assistant", Parts: []Part{{Kind: Thinking, Text: "hmm"}}})
		}
	}
	if _, ok := toolLoopUnansweredOf(withThink); !ok {
		t.Fatalf("a reasoning turn between the calls reset the count")
	}

	// seven turns stay under the threshold
	seven := build(-1, false)[:1+7]
	if _, ok := toolLoopUnansweredOf(seven); ok {
		t.Fatalf("7 answerless turns were stopped")
	}
}

func TestProbeWaitExemptionShape(t *testing.T) {
	// tip's result-shaped check exempts waits via allWaits; record that the
	// answered-wait shape is exempt there while the unanswered one is not.
	args := `{"duration_ms":60000}`
	waits := []Message{{Role: "user", Parts: []Part{{Kind: Text, Text: "go"}}}}
	for range 10 {
		waits = append(waits, probeCalls("clock__sleep", args, 0))
		waits = append(waits, Message{Role: "user", Parts: []Part{{Kind: ToolResult, Text: "slept"}}})
	}
	if _, ok := toolLoopOf(waits); ok {
		t.Fatalf("answered waits were judged a loop by toolLoopOf")
	}
}
