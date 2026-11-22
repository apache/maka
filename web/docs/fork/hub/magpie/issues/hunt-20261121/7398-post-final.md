@yetone @zhenghaowen0967's report: on T3 Code (`agent: "t3code"`) a Codex thread on an `agy-cli/*` model compacted on the thread's own model whatever `codexCompactModel` said — none of the 157 compactions in the report was moved. A long thread sent its whole multi-megabyte history to the plugin, whose 112 KiB single-prompt budget truncated it to the last few messages (`user_after: 0` in the report's `agy_bridge_session` row), the summary was made of those, and the thread resumed amnesiac, re-reading its history after every compaction. The same hole sat under any other Codex pointed at `/v1` (CC Switch's relay tables, #1301).

**Root cause**: T3 Code's magpie · Codex instance points Codex at `/v1` (`t3CodexArgs`, `internal/agent/t3code.go:412`), not at CodexPath, so its compactions arrive at `handle(Responses)` with a `compaction_trigger`. That route has made the summary magpie's own since #1301 (`internal/gateway/gateway.go:2600`), but unlike CodexPath (`internal/gateway/codex_backend.go:225`) it never asked where the compaction should go: `codexCompactTo` — the only reader of `codexCompactModel` — was not called there, and the ask went out on the model the thread was on.

**The fix**: the generic Responses route applies the same move CodexPath does, through `codexCompactTo` unchanged: a compaction of one of magpie's models goes on `codexCompactModel` when one is set, keeping every existing refusal (unset, disabled, unserved, not the gateway key's, a native-compacting target — the ask stays on the session's model and the log says why), and one of Codex's own models stays where it is, as on CodexPath's own-model branches. This takes the reporter's first expectation rather than a T3-specific setting: the route serves any Codex pointed at `/v1`, so a per-client setting would leave the same hole for the others. It is also the magpie-side face our #7189 patch did not touch — that one hands a plugin's fetch the compaction verdict as `X-Magpie-Compaction: 1` so a bridge can keep the turn out of its tool validation; this one moves the compaction itself onto a model that can read the whole history. The plugin half (the silent 112 KiB clip and the read-only compaction path in `packages/agy-cli/index.mjs`) stays Left for the plugins repo, as disclosed there.

**Red without the fix** (the new test on base `0a735cae0`):

```
--- FAIL: TestCodexCompactOnV1OnItsOwnModel
    codex_compact_model_test.go:90: set: 200 …; session 2, other 0
```

— the summary ask, with `codexCompactModel` set to a second provider's model, went to the session model's upstream again. With the fix: `ok`, the ask on the model set for Codex's compactions.

<details><summary>patch: gateway: a compaction on /v1/responses goes on the model set for it (#7398) — git am applies it as is; SHA-256 first 16: 167cff16f6f6cd64</summary>

````
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 21 Nov 2026 17:10:53 +0800
Subject: [PATCH] gateway: a compaction on /v1/responses goes on the model set
 for it (#7398)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

T3 Code's magpie · Codex instance points Codex at /v1 (t3CodexArgs), not
CodexPath, so its compactions arrive on /v1/responses with a
compaction_trigger. There the summary magpie makes stayed on the thread's
model whatever codexCompactModel said: a long agy-cli thread sent its
whole history to the plugin, whose single-prompt cap left the summary a
few last messages, and the conversation resumed amnesiac. One of
magpie's models compacts on the model set for it now, as on CodexPath;
one of Codex's own models stays where it is, as there too.

- TestCodexCompactOnV1OnItsOwnModel: the compaction magpie makes on
  /v1/responses is asked of the model set for Codex's compactions when
  one is set, of the session's own when none is; red on the old code,
  the ask staying on the session's model ("set: 200; session 2, other 0").

Run: go test -tags nogui -count=1 -run Compact ./internal/gateway — ok.
---
 internal/gateway/codex_compact_model_test.go | 34 ++++++++++++++++++++
 internal/gateway/gateway.go                  | 19 ++++++++---
 2 files changed, 49 insertions(+), 4 deletions(-)

diff --git a/internal/gateway/codex_compact_model_test.go b/internal/gateway/codex_compact_model_test.go
index 8124851cf..18fe7e56e 100644
--- a/internal/gateway/codex_compact_model_test.go
+++ b/internal/gateway/codex_compact_model_test.go
@@ -60,6 +60,40 @@ func TestCodexCompactOnItsOwnModel(t *testing.T) {
 	}
 }
 
+// T3 Code's magpie · Codex instance points Codex at /v1 (t3CodexArgs), not
+// CodexPath, so its compactions arrive on /v1/responses with a
+// compaction_trigger: a compaction magpie makes there goes on the model
+// set for it, as one on CodexPath does (#7398 — left on the thread's
+// model, a long agy-cli thread's whole history went to the plugin, whose
+// single-prompt cap left the summary a few last messages).
+func TestCodexCompactOnV1OnItsOwnModel(t *testing.T) {
+	setup(t, provider.Responses, &fake{t: t})
+	sessionURL, session := summaryUpstream(t)
+	otherURL, other := summaryUpstream(t)
+	for _, p := range []provider.Provider{
+		{ID: "fake", Name: "Fake", Key: "k", Models: []string{"m1"}, Responses: sessionURL},
+		{ID: "cheap", Name: "Cheap", Key: "k", Models: []string{"m2"}, Responses: otherURL},
+	} {
+		if err := provider.Save(p); err != nil {
+			t.Fatal(err)
+		}
+	}
+	code, body := post(t, "/v1/responses", systemCompaction)
+	if code != 200 || session() != 1 || other() != 0 {
+		t.Fatalf("unset: %d %s; session %d, other %d", code, body, session(), other())
+	}
+	if err := provider.SetCodexCompactModel("cheap/m2"); err != nil {
+		t.Fatal(err)
+	}
+	code, body = post(t, "/v1/responses", systemCompaction)
+	if code != 200 || session() != 1 || other() != 1 {
+		t.Fatalf("set: %d %s; session %d, other %d", code, body, session(), other())
+	}
+	if sum := compactedText(t, body); !strings.Contains(sum, "SUMMARY") {
+		t.Errorf("summary %q", sum)
+	}
+}
+
 // A compaction a ChatGPT account seals, or one put on such a model, is
 // left where it is: only the account that wrote the summary reads it.
 func TestCodexCompactToLeavesNative(t *testing.T) {
diff --git a/internal/gateway/gateway.go b/internal/gateway/gateway.go
index 2a9186956..26f5bc810 100644
--- a/internal/gateway/gateway.go
+++ b/internal/gateway/gateway.go
@@ -2589,12 +2589,23 @@ func (s *Server) handle(from provider.Protocol) http.HandlerFunc {
 			}
 			// Codex compacts remotely, a compaction_trigger here, on a
 			// provider table named "OpenAI" (CC Switch's relay tables,
-			// which magpie points here, #1301): the summary is magpie's to
-			// make, as on CodexPath, and magpie's summaries go back as text;
-			// a provider set to compact natively is asked Codex's own (#1099)
+			// which magpie points here, #1301, and T3 Code's magpie · Codex
+			// instance, #7398): the summary is magpie's to make, as on
+			// CodexPath, and magpie's summaries go back as text; a provider
+			// set to compact natively is asked Codex's own (#1099). One of
+			// magpie's models compacts on the model set for Codex's
+			// compactions, as on CodexPath — left on the thread's model, a
+			// long agy-cli thread's whole history went to the plugin, whose
+			// single-prompt cap left the summary a few last messages
 			if bodyHas(body, `"compaction`) {
+				native := s.nativeCompactionFor(model)
 				var compact bool
-				if body, compact = codexInputAs(body, true, s.nativeCompactionFor(modelOf(body))); compact {
+				if body, compact = codexInputAs(body, true, native); compact {
+					if strings.Contains(model, "/") {
+						if to := codexCompactTo(r, model, native, s.nativeCompactionFor); to != "" {
+							body = withModel(body, to)
+						}
+					}
 					s.codexCompact(w, r, body)
 					return
 				}
-- 
2.50.1 (Apple Git-155)

````

</details>

**Branch with the commit**: [`fix/7398-t3code-compact-model`](https://github.com/ggbdpq/magpie/tree/fix/7398-t3code-compact-model) (head `e3b3cc02be8721df09360281cf8d09ae759c4be8`), rebased onto current `upstream/main` (`a53f08e11`); on a fresh checkout `git am` applies clean (verified on detached `a53f08e11`: applied, resulting tree byte-identical to the branch head, author kept).

| Check | Result |
| --- | --- |
| `TestCodexCompactOnV1OnItsOwnModel` (new) | red before the fix (`set: 200 …; session 2, other 0` — the ask stayed on the session's model), pass after |
| `go test ./internal/gateway -run Compact -tags nogui -count=1` (the named compaction family) | ok (31s) |
| targeted `-race` over the same | ok (184s) |
| `go test ./internal/gateway/ -tags nogui -timeout 45m -count=1` | FAIL on this box — the same environment-bound set as base `0a735cae0` (the Claude Code CLI/TUI bridge family that needs this machine's real tool shims), run on the branch's cut at `0a735cae0`: 74 failures shared with base, none in the compaction family; the two more on the head run (`TestAskClaudeTUIOn`, `TestClaudeUnloadableSessionStartsAnew`) are that family's load flake, not this route — they exercise `serveClaudeSubscription` on `/v1/messages`, and pass 3× alone and 3× under load on the head tree, 3× alone on base |
| `gofmt -l` on the changed Go files | prints nothing |
| `git diff --check upstream/main..HEAD` | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build` | clean (darwin linker warnings pre-existing) |
| Ablation | removing the `codexCompactTo` move with the test kept turns `TestCodexCompactOnV1OnItsOwnModel` red (line above); restored, green |
| Re-verified on upstream/main `a53f08e11` | rebased from the cut `0a735cae0` onto the current tip (between them: GUI/usage/site rows and one gateway test's env fix, no overlap with the touched files); the named compaction family, targeted `-race`, `go vet` ×3 OSes and `go build` ×3 OSes re-run on the rebased head, all green |

**Siblings**: `codexCompactTo`'s callers are now CodexPath's magpie-model branch (`codex_backend.go:225`) and this route — the same move on both Codex routes. Different by design: CodexPath's own-model branches (through magpie's accounts, `codex_backend.go:299`, and the mask route, `:311`) leave a compaction of one of Codex's own models where it is, a natively sealed summary being readable by its writer's account alone — this route now matches that for its own-model compaction triggers. The unary `/v1/responses/compact` (`responses_compact.go`) is relayed as it came: the sealed item must be written by the serving provider, a translation can't make it, and it 400s for a model nothing Responses-speaking serves, telling the client to compact on `/responses` — which lands on the moved model now. DSH's compaction model (`dshCompactTo`, `dsh_compact.go:28`) is applied at route time on every route (`gateway.go:2962`), so no gap on `/v1` there. Routing rules that match compactions (`Rule.Compact`) still apply when serve routes the moved ask — orthogonal, both compose. Left for the plugins repo, continuing #7189's disclosure: the silent 112 KiB clip and the read-only compaction path (`packages/agy-cli/index.mjs`, `AGY_BRIDGE_MAX_PROMPT_BYTES`).

**Not verified**: a live T3 Code + `agy-cli` scene — the reporter's reproduction needs the plugin's accounts and real paid `agy` requests; the tests here reproduce the request shape at the gateway (a compaction trigger on `/v1/responses` for a magpie model) and move the ask onto a local fake upstream.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
