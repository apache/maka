Rebased onto current main (`18cfe278b`) and re-verified — the branch was moved to today's tip and every claim below re-runs on the new head. No change to the patch: the commit rebases with **zero conflicts** and `git range-diff` reports content-identical (`1: b2ad2612f = 1: 46f03a9ff` — context lines only, where upstream grew the Claude-subscription egress hold and the compaction refusal region beside our two call sites).

Adaptation disclosure (semantic re-check at the new tip, no code change needed):

- upstream's `c1ab9a494` (#7307-family area) added an `inputKindsRefused` path in `attempt`/`passthrough` (`itemsOff`, input items a Responses upstream has no type for). It explicitly keeps the refusal for "a native compaction or sealed task" — a **sealed subagent task** (its `c747ecfa6` seal type), not the sealed compaction checkpoint this gate reads (`sealedCompactions(body)`): the two detectors match different body shapes, and ours still fires before the translation fall-through (`gateway.go:6341`) and on the Claude-subscription branch (`gateway.go:6144`, now beside upstream's `egress.Hold`). Composed, a request carrying both an agent_message item and a sealed compaction is refused by ours first — the silent loss is still impossible.
- upstream's `6e6da86c8` (#7281) relays unary `POST /v1/responses/compact` to a Responses provider with `keep` — never translated, so our gate never sees it.
- upstream's new tests in `native_compaction_test.go` (`TestForeignCompactionLeftOutOfAutoReview` and the input-item suite) stand beside ours, no name or setup collisions (verified below).

<details><summary>patch: gateway: a sealed compaction the request would be translated for is refused, not translated away (#5411) — git am applies it as is; SHA-256 first 16: 19323c87184decd1</summary>

````tFrom 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 23:00:58 +0800
Subject: [PATCH] gateway: a sealed compaction the request would be translated
 for is refused, not translated away (#5411)

---
 internal/gateway/gateway.go                | 35 ++++++++++++++++
 internal/gateway/native_compaction_test.go | 49 ++++++++++++++++++++++
 2 files changed, 84 insertions(+)

diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index da804f14d..218b206d8 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -6138,6 +6138,12 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
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
 		// the user asked for no Claude request to leave while its way out
 		// is in a region Anthropic doesn't list (egress.Hold): it goes no
@@ -6324,6 +6330,17 @@ func (s *Server) attempt(w http.ResponseWriter, r *http.Request, from provider.P
 		}
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
@@ -6357,6 +6374,24 @@ func firstElsewhere(p provider.Provider, model string, from provider.Protocol) b
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
index 7085cfdac..5905be660 100644
--- a/internal/gateway/native_compaction_test.go
+++ b/internal/gateway/native_compaction_test.go
@@ -1091,3 +1091,52 @@ func TestForeignCompactionLeftOutOfAutoReview(t *testing.T) {
 		}
 	})
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

````

</details>

Branch with the commit: [hunt-20261111-rf-5411](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5411) (head `46f03a9ff7ab25b5ccb4f83c38c4ebb2db977f5e`). Patch SHA-256 first 16: `19323c87184decd1`.


| Element | Evidence at `18cfe278b` (head `46f03a9ff`) |
| --- | --- |
| Rebase | `hunt-20261111-rf-5411` = `18cfe278b` + the patch; `git range-diff 705d67efc..b2ad2612f upstream/main..46f03a9ff` reports `1: b2ad2612f = 1: 46f03a9ff` — content identical, zero conflicts |
| git am | the patch (`git format-patch -1 --zero-commit`) `git am`s onto a detached tree at `18cfe278b` to a byte-identical tree: amtest tree `034d78de2006dcde63fec3634d099606bf3c25ed` == branch tree `034d78de2006dcde63fec3634d099606bf3c25ed` |
| Tests | targeted `TestNativeCompactionSealedIsNotTranslatedAway`, `TestNativeCompactionSealedIsNotTranslatedIntoASubscription`: both PASS (with upstream's neighbour `TestForeignCompactionLeftOutOfAutoReview` in the same run); targeted `-race` over ours: ok; `internal/gateway` in full: head and bare base fail the same environment-bound set (below) — zero tip-only failures |
| Ablation | unchanged from the Nov 15 post (the commit is content-identical): product file only reverted (`git checkout HEAD~1 -- internal/gateway/gateway.go`, tests kept), `TestNativeCompactionSealedIsNotTranslatedAway` fails at `native_compaction_test.go:1118: translated: 200 event: response.created` and `TestNativeCompactionSealedIsNotTranslatedIntoASubscription` at `native_compaction_test.go:1140: 502 …`; restored → both green. The same two tests are green on the new head above |
| Siblings | re-scanned at the new tip: `translatedCompaction` still exactly 2 call sites; upstream's input-item path (`itemsOff`/`inputKindWords`) keeps the refusal for a native compaction or sealed task and composes with this gate (distinct seal type, ours fires first on the translated fall-through); `readResponsesFor` still has no compaction case — the translation still drops compaction items, the gate stays load-bearing |
| Real path | unchanged: reproduced at the translation layer through the real gateway HTTP handler (`TestNativeCompactionSealedIsNotTranslatedAway`); a live OpenAI-checkpoint → hosted-Mercury repro: **Not verified** — no OpenAI/Mercury credentials on this machine (as in every earlier post) |

The full `internal/gateway` run (`-tags nogui -timeout 45m -count=1`) fails 74 on the head and 74 on the bare base `18cfe278b`, 73 of them the same environment-bound set on both trees (Claude Code CLI/TUI shims and OpenAI-socket tests that need this machine's real tools) — one flake each side, both in that family: `TestClaudeTUIConversationKeepsItsFolderWhenTheCallerMoves` on the head run, `TestClaudeIdleRunSurvivesARestart` on the base run; each passes and fails across isolated re-runs on both trees. Zero tip-only failures.

Branch with the commit: [hunt-20261111-rf-5411](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5411) (head `46f03a9ff`). Patch SHA-256 first 16: `19323c87184decd1`.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
