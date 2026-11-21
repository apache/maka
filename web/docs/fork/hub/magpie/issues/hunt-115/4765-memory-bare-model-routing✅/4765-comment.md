**Summary**
With magpie as Codex's model provider, Codex's memory consolidation — its own background request, asked on its own default consolidation model by the bare name `gpt-5.6-terra` — resolved that name to `workbuddy-ai`, the only provider with a model under it, and the account it landed on refused the model: `400 "model [gpt-5.6-terra] is not allowed for user type [personal_free_user]"`, three tries, and the memory was never written, while every turn of the conversation itself ran fine on `orbis/gpt-6.1-sol`.

**Root cause**
`codexMemoryStandIn` (the #742 seam that moves Codex's memory calls onto the model its conversation runs on) only acts when magpie knows *nothing* by the name the call came with. Here the bare name happened to resolve — a provider serves a model under the same name — so the call was taken as a pick of that provider's model and routed to it, though it is Codex's own built-in default, not a pick at all. On the ChatGPT backend's path the same call follows the conversation when Codex's config names no model (`codexFollowTo`); the `/v1` path had no such step for a name that resolves.

**Fix** (11296ff35, branch below)
When a Codex memory call's bare name resolves, `codexMemoryStandIn` now still asks where the conversation runs (`codexMemorySession`, the same source the backend path uses) and sends the call there, before falling through to the name's own resolution. What keeps going exactly where the name resolves: any non-memory call (a plain turn on the name is the user's own pick), a model Codex's config names for its memories (`[memories] extract_model` / `consolidation_model`, the workaround you already found — a config magpie can't read counts as named), and a call whose conversation magpie has no model of yet.

**Deliberately not changed**
The three tries on a capability refusal and the model catalog exposing a model an account can't serve (your suggestions 2 and 3) are a bigger cut and left alone; and the auto-review's `codex-auto-review` plus the app's title/description/summary calls keep their as-Codex-sent default on a resolving name — a provider serving a luna-named model picking titles up is the wanted behavior there (#4590).

**Verification**
| Check | Result |
|---|---|
| `TestCodexMemoryOnACollidingBareNameFollowsTheSession` (new: wb serves `gpt-5.6-terra`, conversation on another provider; memory call must follow the session, the named provider must get nothing; the config's pick and a plain turn must still go to it) | red before the fix (`the provider with the name got the memory (1 requests)`), green after |
| Ablation (revert `codex_memory.go`, test kept) | red again with the report's routing; restore, green |
| Watched seams: `TestCodexMemoryCallsGoWhereItsTurnsGo`, `TestCodexMemoryStandInFollowsTheSwitch`, `TestCodexMemoriesFollowTheSession`, `TestCodexSideCallsKeepTheConfigsModel`, `TestCodexSideCallsBeforeTheFirstTurnFollowTheSwitch`, `TestCodexMemoryOfASwitchedConversationFollowsTheSwitch`, `TestCodexOwnModelOnMagpieThread*` (18 tests) | ok |
| `go test -tags nogui -count=1 ./internal/gateway` (temp HOME) | ok (545s) |
| `gofmt -l`, `go vet` (darwin/linux/windows, `-tags nogui`) | clean |
| Builds darwin / `GOOS=linux` / `GOOS=windows` (`-tags nogui`) | ok |

**Not verified**
Not tried against a real Codex desktop with `workbuddy-ai`-style accounts: the reproducing setup (a provider whose account plan refuses one of Codex's own model names) isn't available here — the test stands in for it with two relay providers. The upstream-facing behavior of suggestion 2 (learning `(account, model)` capability from refusals) and 3 (catalog filtering) is untouched.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Codex memory call on its own bare name follows the session when a provider serves a model under that name too (#4765) — git am applies it as is; SHA-256 first 16: ce81c627317fbcdf</summary>

```patch
From 11296ff3503e369ecd9fb5b1f7a0097b6eb2d46f Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 19:35:50 +0800
Subject: [PATCH] gateway: a Codex memory call on its own bare name follows the
 session when a provider serves a model under that name too (#4765)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

raphael-y7: with magpie as Codex's model provider, the conversation on
orbis/gpt-6.1-sol, Codex's memory consolidation — its own background
request on its own default consolidation model, asked by its bare name
gpt-5.6-terra — went to workbuddy-ai, the only provider of magpie's with
a model under that name, and the account it landed on refused it: 400
"model [gpt-5.6-terra] is not allowed for user type
[personal_free_user]", three tries, 8.5s, and the memory was never
written. The bare name resolved, so codexMemoryStandIn (#742) left the
call where it stood; a model of Codex's own asked by its bare name is
not a pick of whichever provider has one under that name.

Now a memory call whose bare name resolves still follows the
conversation's model, as it does on the ChatGPT backend's path
(codexFollowTo), when Codex's config names no model for its memories:
codexMemoryStandIn asks codexMemorySession first and only falls through
to the name's own resolution when there is none to follow. What keeps
going as the name resolves: any other call, a model Codex's config
names (the user's own pick, a full id or a bare name), a config magpie
can't read, and a conversation magpie has no model of (on Codex's own,
or nothing answered yet).

What this doesn't change: the three tries on a capability refusal, and
the model catalog's exposure of a model an account can't serve — the
reporter's other two suggestions, both a bigger cut; the auto-review's
codex-auto-review and the app's title, description and summary calls,
whose as-Codex-sent default is deliberate (codexTitlesTo, codexSideTo;
shruru counts a provider serving a luna-named model picking titles up
as a feature, #4590).

TestCodexMemoryOnACollidingBareNameFollowsTheSession: a provider with a
model under gpt-5.6-terra, the conversation on another provider's — the
memory call followed the conversation and the named provider got
nothing (red before: it got the memory); the config's pick and a plain
turn on the name still go to it. Run (darwin arm64, -tags nogui):

- go test -tags nogui -run 'TestCodexMemoryOnACollidingBareNameFollowsTheSession|TestCodexMemoryCallsGoWhereItsTurnsGo|TestCodexMemoryStandInFollowsTheSwitch|TestCodexMemoriesFollowTheSession|TestCodexSideCallsKeepTheConfigsModel|TestCodexSideCallsBeforeTheFirstTurnFollowTheSwitch|TestCodexOwnModelOnMagpieThreadGoesOnSignIn' ./internal/gateway: ok (the new test was red before the fix, with the report's routing)

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/codex_memory.go      | 19 +++++++++-
 internal/gateway/codex_memory_test.go | 54 +++++++++++++++++++++++++++
 2 files changed, 72 insertions(+), 1 deletion(-)

diff --git a/internal/gateway/codex_memory.go b/internal/gateway/codex_memory.go
index 7cc97d425..e6199e225 100644
--- a/internal/gateway/codex_memory.go
+++ b/internal/gateway/codex_memory.go
@@ -74,7 +74,24 @@ func (s *Server) codexMemoryStandIn(r *http.Request, who, agent, kind, asked str
 		return ""
 	}
 	if _, _, ok := provider.Resolve(asked); ok {
-		return ""
+		// A memory call on one of Codex's own bare defaults that a
+		// provider of magpie's happens to serve under the same name:
+		// the name is Codex's own, not a pick of that provider's model,
+		// and the account it resolves to may refuse the model outright
+		// (400, three tries, the memory lost, #4765). With Codex's
+		// config naming no model for its memories, the call follows the
+		// conversation's, as it does on the ChatGPT backend's path
+		// (codexFollowTo). "" keeps it where the name resolves: any
+		// other call, the config's own pick, a call whose config magpie
+		// can't read, or no conversation of magpie's to follow.
+		if !isMemoryKind(kind) || CodexSideSet == nil || CodexSideSet("memories") {
+			return ""
+		}
+		to := s.codexMemorySession(r, body)
+		if to == "" || to == asked {
+			return ""
+		}
+		return to
 	}
 	if isMemoryKind(kind) {
 		if m := s.codexLeads.sideOf(r, body, true); m != "" && m != asked {
diff --git a/internal/gateway/codex_memory_test.go b/internal/gateway/codex_memory_test.go
index 12893b448..464df495f 100644
--- a/internal/gateway/codex_memory_test.go
+++ b/internal/gateway/codex_memory_test.go
@@ -90,3 +90,57 @@ func TestCodexMemoryCallsGoWhereItsTurnsGo(t *testing.T) {
 		t.Fatalf("a review on an unknown model: %d", rec.Code)
 	}
 }
+
+// #4765 (raphael-y7): Codex's memory consolidation asks for its own bare
+// default (gpt-5.6-terra), and a provider of magpie's happened to serve a
+// model under that same name: the call went to it — the only one with the
+// name — and its account refused the model (400, three tries, the memory
+// lost) while the conversation ran on another provider's model. With
+// Codex's config naming no model for its memories, the call follows the
+// conversation's, as it does on the ChatGPT backend's path (codexFollowTo);
+// a model Codex's config names, and a turn of Codex's on the name, go as
+// they came.
+func TestCodexMemoryOnACollidingBareNameFollowsTheSession(t *testing.T) {
+	fresh(t)
+	relay := &relayOfChatGPT{}
+	wb := httptest.NewServer(relay)
+	t.Cleanup(wb.Close)
+	if err := provider.Save(provider.Provider{ID: "wb", Name: "WB", Key: "sk-wb", Models: []string{"gpt-5.6-terra"}, Responses: wb.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	session := relayOn(t, "third")
+	was := CodexSideSet
+	CodexSideSet = func(string) bool { return false }
+	t.Cleanup(func() { CodexSideSet = was })
+	s := New()
+	if rec := codexCall(t, s, "third/gpt-6-astra", ""); rec.Code != 200 {
+		t.Fatalf("the turn: %d %s", rec.Code, rec.Body.String())
+	}
+	if rec := codexCall(t, s, "gpt-5.6-terra", "memory_consolidation"); rec.Code != 200 {
+		t.Fatalf("memory: %d %s", rec.Code, rec.Body.String())
+	}
+	if reqs := relay.requests(); len(reqs) != 0 {
+		t.Fatalf("the provider with the name got the memory (%d requests)", len(reqs))
+	}
+	reqs := session.requests()
+	if len(reqs) != 2 || modelOf([]byte(reqs[1])) != "gpt-6-astra" {
+		t.Fatalf("the session's provider got %d requests, the last on %q", len(reqs), modelOf([]byte(reqs[len(reqs)-1])))
+	}
+
+	// a model Codex's config names is the user's own pick: as it came
+	CodexSideSet = func(string) bool { return true }
+	if rec := codexCall(t, s, "gpt-5.6-terra", "memory_consolidation"); rec.Code != 200 {
+		t.Fatalf("memory on the config's model: %d %s", rec.Code, rec.Body.String())
+	}
+	if reqs := relay.requests(); len(reqs) != 1 || modelOf([]byte(reqs[0])) != "gpt-5.6-terra" {
+		t.Fatalf("the provider with the name got %d requests on the config's pick", len(reqs))
+	}
+
+	// a turn of Codex's on the name is the user's own pick of it: as it resolves
+	if rec := codexCall(t, s, "gpt-5.6-terra", ""); rec.Code != 200 {
+		t.Fatalf("a turn on the name: %d %s", rec.Code, rec.Body.String())
+	}
+	if reqs := relay.requests(); len(reqs) != 2 {
+		t.Fatalf("the provider with the name got %d requests, the turn among them", len(reqs))
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/4765-memory-bare-model-routing](https://github.com/ggbdpq/magpie/tree/fix/4765-memory-bare-model-routing) (head `11296ff3503e369ecd9fb5b1f7a0097b6eb2d46f`).
