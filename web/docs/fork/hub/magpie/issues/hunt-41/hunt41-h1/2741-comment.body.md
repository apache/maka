Your source reading matches main (`b14784c0`): the gap is `chatReplaysReasoning` in `internal/gateway/chat.go`. It matches DeepSeek's models wherever they are served and Command Code's plugin id (`commandcode-plan`, db024bcd) — but a built-in API-key account is not a plugin, so `buildHost` returns its real host `api.commandcode.ai`, which the check doesn't know. `replay` comes out false and every replayed assistant turn goes without `reasoning_content`, which your cat-jam/beam probes show those models turn away.

## Root cause

`buildChat` computes `replay := chatReplaysReasoning(host, model)` (internal/gateway/chat.go:273), and the relay path guards `withReasoningOnToolTurns` with the same predicate over `buildHost(p)` (internal/gateway/gateway.go:4077). For the built-in both read `api.commandcode.ai` and get false, so neither the thinking the client kept nor the `noReasoning` space lands on a replayed turn. Your minimal repro is exactly the branch this leaves closed: `[user, assistant + reasoning_content] → 200`, `[user, assistant] → 400`.

## Fix

Add the built-in's host to the predicate:

```go
func chatReplaysReasoning(host, model string) bool {
	return strings.Contains(host, "deepseek") || strings.Contains(strings.ToLower(model), "deepseek") ||
		host == provider.CommandCodePlanID || host == "api.commandcode.ai"
}
```

This restores what the built-in itself did to `/alpha/generate` (db024bcd's message) and what its plugin already does for the whole catalog today — so for the vendor's other models (e.g. `stealth/glyph-cluster:free`, which doesn't validate) the change is bounded by behavior they already get on the plugin route. I kept it at host granularity rather than a `stealth/`/`reflection/` prefix list: the vendor is one host, and per-model name lists are the drift-prone shape this family keeps hitting. Both consumers move together since they share the predicate.

Left out, with reasons: `replaysReasoning` (Responses, internal/gateway/responses.go:838) and `anthropicReplaysThinking` (internal/gateway/anthropic.go:286) — #2741's evidence is Chat-only, and nothing reports Command Code's Responses or Anthropic endpoints reading reasoning back; the other plugin ids `buildHost` names (cursor, devin, qoder, qoder-cn) — nothing reports their built-ins reading it either. The issue's two side notes stay out as well: `membersIn` not filtering named group members (reads as declared behavior), and the 400 not triggering group failover (#1765 tracks that).

## Verification

Base `b14784c03fd9e410f34e6aa8ff1ae357dfe6078b`, patch `72133c0e`, macOS arm64, isolated HOME, `-tags nogui`.

| Check | Command | Result |
| --- | --- | --- |
| New tests on base | `go test -tags nogui -count=1 -run 'TestCommandCodeBuiltInReplaysReasoning|TestBuiltInCommandCodeBuildsForItsAPIHost' ./internal/gateway` | RED (below); with the fix `ok` |
| Family | same plus `-run 'CommandCode|ChatToolTurn|ReasoningOnToolTurns|ResumePrefill|ReasoningDetails|DeepSeekStepLead|DeepSeekAnthropic|MovedBuildHost|PluginToolFailure|PluginReasoning'` | `ok` |
| Full gateway package | `go test -tags nogui -count=1 -timeout 40m ./internal/gateway` | `ok` 351.2s |
| Ablation | product file back at base, tests kept | the same two assertions fail; restored `ok` |
| Mutation | predicate `return true` | the api.openai.com negative control fails; restored `ok` |
| Format/vet | `gofmt -l`; `go vet`, `GOOS=linux go vet`, `GOOS=windows go vet` | clean |
| Builds | linux / windows / darwin, `-tags nogui` | all ok |

Red without the fix (base `b14784c0`, tests kept, product file reverted):

```
--- FAIL: TestCommandCodeBuiltInReplaysReasoning
    commandcode_builtin_replay_test.go:21: the built-in's API host got reasoning <nil>
    commandcode_builtin_replay_test.go:45: the built-in's tool call without thinking went without reasoning_content: map[role:assistant tool_calls:[map[function:map[arguments:{} name:get_time] id:call_1 type:function]]]
```

The new tests sit in `internal/gateway/commandcode_builtin_replay_test.go`; one is the built-in companion of `TestMovedBuildHostIsPlugin` (a preset-shaped built-in builds for `api.commandcode.ai`, a moved account for its plugin id).

<details>
<summary>format-patch (72133c0e)</summary>

````text
From 72133c0e925268c57ce227c97c1faf32c2a121e7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 18 Oct 2026 02:34:51 +0800
Subject: [PATCH] gateway: the built-in Command Code's replayed turns carry
 reasoning_content again

What changed:
chatReplaysReasoning also matches the built-in's API host,
api.commandcode.ai. A Go conversation moved onto the plugin is built for
the plugin's id and was already replayed (db024bcd); a built-in API-key
account is built for api.commandcode.ai, which the check missed, so every
replayed assistant turn went without reasoning_content and the
/provider/v1 stealth and reflection models turn such a turn away with
"Missing required parameter: 'messages[1].reasoning_content'" (#2741).
The built-in itself replayed each turn's reasoning to /alpha/generate and
its plugin replays for the whole catalog today, so its host gets the same
treatment. The relay path's guard reads the same predicate
(chatReplaysReasoning of buildHost(p)), so both consumers move together;
the Responses (replaysReasoning) and Anthropic (anthropicReplaysThinking)
siblings stay untouched, as no Command Code evidence exists on those
protocols.

Run:
go test -tags nogui -count=1 -run 'TestCommandCodeBuiltInReplaysReasoning|TestBuiltInCommandCodeBuildsForItsAPIHost' ./internal/gateway
- at base b14784c03fd9e410f34e6aa8ff1ae357dfe6078b the new
  TestCommandCodeBuiltInReplaysReasoning fails twice (the built-in's
  reasoning <nil> on a thinking turn; a tool call without
  reasoning_content); TestBuiltInCommandCodeBuildsForItsAPIHost passes.
- with the change: ok. Family (plugin parity, DeepSeek replay, Mistral
  exclusion, translated path) ok.
- ablation, product file back at b14784c0 with the tests kept: the same
  two assertions fail; restored: ok. Mutation, the predicate true for
  everything: the api.openai.com negative control fails; restored: ok.
- gofmt -l clean; go vet, GOOS=linux/windows go vet, linux/windows/darwin
  builds pass.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/chat.go                      | 11 +--
 .../commandcode_builtin_replay_test.go        | 71 +++++++++++++++++++
 2 files changed, 78 insertions(+), 4 deletions(-)
 create mode 100644 internal/gateway/commandcode_builtin_replay_test.go

diff --git a/internal/gateway/chat.go b/internal/gateway/chat.go
index b6b38ddb..025cdcec 100644
--- a/internal/gateway/chat.go
+++ b/internal/gateway/chat.go
@@ -258,11 +258,14 @@ var failedAsText = map[string]bool{"devin": true, "qoder": true, "qoder-cn": tru
 // chatReplaysReasoning is whether a Chat upstream wants a turn's reasoning
 // back in reasoning_content: DeepSeek's models wherever they are served
 // (#388), the model named as the provider names it (OpenCode Go's
-// deepseek-v4.1-flash, whose host doesn't say so), and Command Code's
-// plugin, which replays it for a Go key as the built-in did to
-// /alpha/generate.
+// deepseek-v4.1-flash, whose host doesn't say so), and Command Code —
+// the plugin a Go conversation moves onto replays it, and the built-in
+// did too, to /alpha/generate: its /provider/v1 stealth and reflection
+// models still turn a replayed turn whose assistant message carries none
+// away (#2741).
 func chatReplaysReasoning(host, model string) bool {
-	return strings.Contains(host, "deepseek") || strings.Contains(strings.ToLower(model), "deepseek") || host == provider.CommandCodePlanID
+	return strings.Contains(host, "deepseek") || strings.Contains(strings.ToLower(model), "deepseek") ||
+		host == provider.CommandCodePlanID || host == "api.commandcode.ai"
 }
 
 func buildChat(r *Request, model, host string, rejectTemp bool) []byte {
diff --git a/internal/gateway/commandcode_builtin_replay_test.go b/internal/gateway/commandcode_builtin_replay_test.go
new file mode 100644
index 00000000..198642c2
--- /dev/null
+++ b/internal/gateway/commandcode_builtin_replay_test.go
@@ -0,0 +1,71 @@
+package gateway
+
+import (
+	"encoding/json"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// The built-in Command Code provider (api.commandcode.ai) reads a turn's
+// reasoning back, as it did to /alpha/generate and as its plugin does for
+// a moved Go account (TestCommandCodePluginReasoning): its stealth and
+// reflection models turn a replayed turn whose assistant message carries
+// no reasoning_content away ("Missing required parameter:
+// 'messages[1].reasoning_content'", #2741). The thinking the client kept
+// goes back as it is, a tool-call turn with none gets the space DeepSeek's
+// Chat API takes (noReasoning), and an upstream that reads no reasoning
+// back (api.openai.com) gets neither.
+func TestCommandCodeBuiltInReplaysReasoning(t *testing.T) {
+	if got := chatBody(t, "api.commandcode.ai")["messages"].([]any)[1].(map[string]any)["reasoning_content"]; got != "pondered" {
+		t.Errorf("the built-in's API host got reasoning %v", got)
+	}
+	r := &Request{Messages: []Message{
+		{Role: "user", Parts: []Part{{Kind: Text, Text: "what time is it?"}}},
+		{Role: "assistant", Parts: []Part{{Kind: ToolCall, ID: "call_1", Name: "get_time"}}},
+		{Role: "user", Parts: []Part{{Kind: Text, Text: "and now?"}}},
+	}}
+	toolTurn := func(host string) map[string]any {
+		t.Helper()
+		var v struct {
+			Messages []map[string]any `json:"messages"`
+		}
+		if err := json.Unmarshal(buildChat(r, "commandcode/stealth/cat-jam:free", host, false), &v); err != nil {
+			t.Fatal(err)
+		}
+		for _, m := range v.Messages {
+			if m["tool_calls"] != nil {
+				return m
+			}
+		}
+		t.Fatalf("%s: no tool-call message in %v", host, v.Messages)
+		return nil
+	}
+	if m := toolTurn("api.commandcode.ai"); m["reasoning_content"] != noReasoning {
+		t.Errorf("the built-in's tool call without thinking went without reasoning_content: %v", m)
+	}
+	if m := toolTurn("api.openai.com"); m["reasoning_content"] != nil {
+		t.Errorf("api.openai.com was given reasoning_content: %v", m)
+	}
+}
+
+// The built-in is no plugin: its chat request is built for its API host,
+// the same one the relayed path's guard reads (chatReplaysReasoning of
+// buildHost(p)), as a moved account's is built for its plugin's
+// (TestMovedBuildHostIsPlugin).
+func TestBuiltInCommandCodeBuildsForItsAPIHost(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	p := provider.Provider{ID: "commandcode", Name: "Command Code", Key: "k",
+		Chat: "https://api.commandcode.ai/provider/v1", Responses: "https://api.commandcode.ai/provider/v1"}
+	if err := provider.Save(p); err != nil {
+		t.Fatal(err)
+	}
+	saved, err := provider.Find("commandcode")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if got := buildHost(*saved); got != "api.commandcode.ai" {
+		t.Fatalf("buildHost = %q, want the built-in's API host", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)
````

</details>

---
**Source**: reported in #2741 — the 400s from api.commandcode.ai and the source reading are the reporter's; the fix and the tests are mine.

**Siblings**: `rg -n "chatReplaysReasoning" internal/` → two production consumers (`buildChat` internal/gateway/chat.go:273, relay guard internal/gateway/gateway.go:4077), one predicate, both covered by the change. `rg -n "api\.commandcode\.ai"` elsewhere → internal/gateway/search.go (`searchModelsHosts`), internal/provider/balance.go, planquota.go, commandcode_plan.go — usage, balance and search-model keys, different concepts, untouched.

**When the read fails**: not applicable — the decision reads no file and no network; an unmatched host behaves exactly as today.

**Not verified**: a real Command Code key end to end (your captured 400s stand in for that side); `stealth/glyph-cluster:free` with replay on against the real API — locally bounded by the plugin already replaying for this vendor's catalog and by the built-in's own /alpha/generate behavior, but it is the one behavior change the patch makes for models that never asked.

**AI**: I've read the whole diff and can answer questions on it myself.
