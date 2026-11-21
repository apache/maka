**What's wrong**

A Responses request whose input carries a native compaction checkpoint (sealed `encrypted_content`) and that magpie must *translate* for the destination loses the checkpoint silently: the translation reads no compaction item, the destination is asked without the earlier conversation, and the request comes back HTTP 200 as if the history were there. With the checkpoint the only copy of the earlier turns — a checkpoint-only handoff — the model answers with no earlier context (@muness's repro: three facts given on OpenAI, compacted, the checkpoint asked of Mercury, the answer UNKNOWN).

**Root cause**

A compaction sealed where native compaction is on routes only to its writer (`checkpointReaders`), and a request for its writer goes as it came (`keepsCompaction`) — the guards `#1099`/`#2642` built. But a writer magpie *doesn't* know — a checkpoint carried over by hand, or by another magpie, or a `compactions.json` that lost the entry — routes anywhere. `attempt` then translates the request for a destination that can't be asked Responses, and the translation reads no compaction item (`readResponsesFor` has no case for `compaction`): the sealed checkpoint goes out left out, nothing says so, the status is 200. The gateway's own rule (`native_compaction.go`) is that the compaction is never sent to another to be refused, dropped, or summarised in its place unasked — the routing gate keeps that rule for a known writer, but nothing kept it on the translation path for an unknown one.

**The fix**

`attempt` refuses a Responses request carrying a sealed compaction, said why, at the two points where it would be translated: inside the Claude-subscription branch (a subscription is asked only translated), and at the fall-through to `translate`. What is relayed as it came keeps its say — the destination reads the seal, or refuses it and is asked again without (`withoutSeals`, `withoutCompaction`, the waroy recovery). magpie's own summaries (`magpie1:`) are untouched: `sealedCompactions` excludes them, and they are restored to their message before routing (`codexInputAs`). The refusal names the way on: ask where the request goes as it came, or start a new conversation — the same promise `checkpointError` makes. The opt-in recovery @muness drafted (expanding the checkpoint through the caller's ChatGPT credentials, `codexCheckpointModel`) is a feature of its own; this patch only closes the silent path, which is what the gateway already promises not to do.

Branch `fix/5411-checkpoint-handoff` at [ggbdpq/magpie](https://github.com/ggbdpq/magpie/tree/fix/5411-checkpoint-handoff), head `672161f20`, based on `80ae904c2` (current `upstream/main`). Applies with `git am`.

<details>
<summary>0001-gateway-a-sealed-compaction-the-request-would-be-tra.patch</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 23:00:58 +0800
Subject: [PATCH] gateway: a sealed compaction the request would be translated
 for is refused, not translated away (#5411)

---
 internal/gateway/gateway.go                | 35 ++++++++++++++++
 internal/gateway/native_compaction_test.go | 49 ++++++++++++++++++++++
 2 files changed, 84 insertions(+)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index d2a1e8ecb..3f68cf996 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -5182,6 +5182,12 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 	// OAuth HTTP requests are content-classified as third-party traffic when
 	// they carry another agent's harness (Pi, OpenCode, and others).
 	if p.Account != nil && p.Account.Agent == "claude" {
+		// a subscription is asked only translated, so a sealed compaction
+		// the routing doesn't hold to its writer (translatedCompaction)
+		// is refused before it is read as nothing (#5411)
+		if msg, refused := translatedCompaction(p, model, from, body); refused {
+			return writeError(w, from, 400, msg), msg
+		}
 		call.To = provider.Anthropic
 		return s.serveClaudeSubscription(w, r, from, p, model, body, &call.Usage)
 	}
@@ -5322,6 +5328,17 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 		msg := fmt.Sprintf("%s doesn't serve %s on the Responses API, so Codex's native compaction can't be asked of it", p.Name, model)
 		return writeError(w, from, 400, msg), msg
 	}
+	// from here the request is translated, and a translation reads no
+	// compaction item: a sealed one — whose writer magpie doesn't know, a
+	// known one never routing here (checkpointReaders) — went out left
+	// out, and a checkpoint-only handoff lost the conversation's earlier
+	// turns silently, answered 200 (#5411). Refused, as a known writer's
+	// is: the seal can't be carried where the request is translated, and
+	// magpie doesn't drop it or summarise it in its place unasked. What
+	// was relayed as it came had its say above; this is the silent path.
+	if msg, refused := translatedCompaction(p, model, from, body); refused {
+		return writeError(w, from, 400, msg), msg
+	}
 	to := s.usable(p, model)
 	if len(to) == 0 {
 		// every API turned the model away: the one the user picked for it
@@ -5355,6 +5372,24 @@ func firstElsewhere(p provider.Provider, model string, from provider.Protocol) b
 	return p.ResponsesFirst(model) && from != provider.Responses || p.MessagesFirst(model) && from != provider.Anthropic
 }
 
+// translatedCompaction is the refusal a Responses request carrying a
+// sealed compaction is answered when it would be translated: a
+// translation reads no compaction item, and a checkpoint-only handoff
+// lost the conversation's earlier turns silently, answered 200 (#5411).
+// A writer magpie knows never routes there (checkpointReaders); one it
+// doesn't — a checkpoint carried over by hand, or by another magpie —
+// did. Refused, as a known writer's is: the seal can't be carried where
+// the request is translated, and magpie doesn't drop it or summarise it
+// in its place unasked. What is relayed as it came keeps its say — the
+// destination reads it, or refuses it and is asked again without
+// (withoutSeals, withoutCompaction); this is only the silent path.
+func translatedCompaction(p provider.Provider, model string, from provider.Protocol, body []byte) (string, bool) {
+	if from != provider.Responses || len(sealedCompactions(body)) == 0 {
+		return "", false
+	}
+	return fmt.Sprintf("This conversation was compacted natively: its earlier turns are sealed in a compaction (encrypted_content) only the key or account that wrote it reads. %s answers %s on an API the request must be translated for, and a translation leaves the compaction out, silently losing the conversation's earlier context. magpie doesn't drop it or summarise it in its place unasked: ask for %s where the request goes as it came (the account that compacted this conversation), or start a new conversation.", p.Name, model, model), true
+}
+
 // autoPicks is whether c is Copilot's Auto, which picks the model itself.
 func autoPicks(c candidate) bool {
 	return c.model == provider.CopilotAuto && c.p.Account != nil && c.p.Account.Agent == "copilot"
diff --git a/internal/gateway/native_compaction_test.go b/internal/gateway/native_compaction_test.go
index 408e7bfce..c6ec55a39 100644
--- a/internal/gateway/native_compaction_test.go
+++ b/internal/gateway/native_compaction_test.go
@@ -940,3 +940,52 @@ func TestNativeCompactionDecisionLeavesTheTurnsAlone(t *testing.T) {
 		}
 	}
 }
+
+// A sealed compaction whose writer magpie doesn't know (never recorded: a
+// checkpoint carried over by hand, or by another magpie), asked of a
+// provider the request must be translated for, was dropped by the
+// translation — which reads no compaction item — and a checkpoint-only
+// handoff lost the conversation's earlier turns silently, answered 200
+// (#5411). Refused now, said why, the provider never asked. A provider
+// that takes the request as it came is still asked, seal and all: what it
+// says of a seal it can't read is its own.
+func TestNativeCompactionSealedIsNotTranslatedAway(t *testing.T) {
+	chat := &fake{t: t, reply: sse(
+		`data: {"id":"c1","model":"m1","choices":[{"delta":{"role":"assistant","content":"ANSWER"}}]}`,
+		`data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)}
+	setup(t, provider.Chat, chat)
+	relay := &fake{t: t, reply: sse(`data: {"type":"response.completed","response":{"id":"resp_r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`)}
+	up := httptest.NewServer(relay)
+	t.Cleanup(up.Close)
+	if err := provider.Save(provider.Provider{ID: "other", Name: "Other", Key: "k2", Models: []string{"m1"}, Responses: up.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	sealed := `{"model":"%s","stream":true,"input":[{"type":"compaction","encrypted_content":"gAAAAB-sealed-unknown"},{"type":"message","role":"user","content":[{"type":"input_text","text":"what were the three facts?"}]}]}`
+
+	code, body := post(t, "/v1/responses", strings.Replace(sealed, "%s", "fake/m1", 1))
+	if code != 400 || !strings.Contains(body, "compacted natively") || !strings.Contains(body, "translated") {
+		t.Fatalf("translated: %d %s", code, body)
+	}
+	if chat.calls != 0 {
+		t.Errorf("the translated provider was asked: %s", chat.got)
+	}
+
+	code, body = post(t, "/v1/responses", strings.Replace(sealed, "%s", "other/m1", 1))
+	if code != 200 || !strings.Contains(string(relay.got), `"encrypted_content":"gAAAAB-sealed-unknown"`) {
+		t.Errorf("relayed: %d %s\nrelay got %s", code, body, relay.got)
+	}
+}
+
+// A subscription is asked only translated: refused there too, before the
+// compaction is read as nothing (#5411).
+func TestNativeCompactionSealedIsNotTranslatedIntoASubscription(t *testing.T) {
+	s := New()
+	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
+	body := `{"model":"claude-sonnet-5","stream":true,"input":[{"type":"compaction","encrypted_content":"gAAAAB-sealed-unknown"},{"type":"message","role":"user","content":[{"type":"input_text","text":"what were the three facts?"}]}]}`
+	rec := httptest.NewRecorder()
+	var call Call
+	code, msg := s.attempt(rec, httptest.NewRequest("POST", "/v1/responses", nil), provider.Responses, p, "claude-sonnet-5", []byte(body), &call)
+	if code != 400 || !strings.Contains(msg, "compacted natively") || !strings.Contains(msg, "translated") {
+		t.Fatalf("%d %s", code, msg)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

SHA-256 (first 16): `e9aac43e28efaa2e`

**Verification**

| check | result |
| --- | --- |
| `TestNativeCompactionSealedIsNotTranslatedAway` (new) — RED before the fix, failing exactly as reported: the translated provider asked without the compaction, answered 200 | PASS after |
| `TestNativeCompactionSealedIsNotTranslatedIntoASubscription` (new) | PASS |
| Ablation: only `internal/gateway/gateway.go` checked out back at the parent (`12a9970d6`), both tests | RED (`translated: 200 …`) → restored → GREEN |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok 680.9s at the pre-rebase head; re-run at `672161f20` (this table's head): ok 651.8s |
| `go test ./internal/gateway/ -run 'TestNativeCompaction' -race -count=1` | ok |
| `gofmt -l` on both touched files | clean |
| `go vet -tags nogui ./internal/gateway/`, darwin and `GOOS=linux` | clean |
| `go build ./...` | ok |
| `git am` of the patch onto `80ae904c2` | clean → `59e434047` |
| Pre-existing reds `TestMothX`, `TestLaneLimitRoutes`, `TestProxyCheckSaysAProxyPassedBy` | still failing here, as before this patch (they live in `internal/agent` and `internal/gui`; this diff touches `internal/gateway` only) |

**Not verified**

Not verified against a live OpenAI checkpoint or hosted Mercury — no credentials on this machine; the repro stands on the regression test's hand-carried checkpoint, which failed exactly as reported before the fix. Not verified: the relayed-to-a-Responses-speaking-destination path against a real destination that silently *ignores* a foreign seal — magpie relays it as it came there (unchanged by this patch), and a destination that says nothing gives magpie nothing to react to; closing that case is the recovery feature @muness proposed, which is the maintainer's call.

Attribution: patch written by GLM-5.3-Flash (ZCode), authored as ggbdpq; reported by @muness, whose draft ([muness/magpie#1](https://github.com/muness/magpie/pull/1)) framed the report and whose existing guards for recorded writers this patch keeps.

Generated-by: GLM-5.3-Flash (ZCode)
