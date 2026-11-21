Status refresh on the patch above (posted Nov 10 against `db0f2f20d`) — no movement here since, so this is the same change replayed onto today's main with the evidence re-run on the new head.

**Upstream drifted around it, not into it.** Since `db0f2f20d`, `internal/agent/claude.go` changed three times (a model listed by its 1M id runs to 1M — 900d1673d; Claude's own subscription ids in the model variables — fe8c05e0c; the main model written as a tier alias — aa2ea5c90). None of them reads `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` or touches the deleted-field-replanted branch of `writeBudgets`, so the report's restart loop is still open on main. The patch applies to `873b4987e` unchanged: the two diffs — original and replayed — are byte-identical apart from the blob index lines and hunk offsets (zero-drift self-check), and the replayed tree matches the branch head byte for byte.

**Fresh on the new head** (`c598af1d4`, the replay):

| Check | Result |
| --- | --- |
| the 14-test window/compact family (the two new ones + `TestClaudeDesktopContextWindow` and its 1M/Alone/WSL legs, `TestClaudeContextWindow`, `TestClaudeCompactWindow`, `TestClaudeCompactAt`, `TestClaudeCompactYieldsToOwnSetting`, `TestClaudeGroupCompactWindow`, `TestClaudeCompactWindowBedrockClaude`, `TestClaudePlan`, `TestBudgetPath`) | `ok` |
| the two new tests with `-race` | `ok` |
| ablation, each hunk lifted from the committed fix, tests kept | the desktop-plan clause out of `writeWindow` → `TestClaudeDesktopCompactPctDeclaration` red on the report's loop verbatim: `the deleted top-level autoCompactWindow was written again: "272000"`; the pct clause out of `writeCompact` → `TestClaudeCompactPctGivesWay` red: `declared share held to the working window: "272000"`; each restored → `ok` |
| `gofmt -l` on the changed files | clean |
| `go vet ./internal/agent`; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | ok; ok; ok |
| `go build ./internal/agent`; `GOOS=linux … -tags nogui`; `GOOS=windows` | ok; ok; ok |
| `go test ./internal/agent -count=1 -timeout 25m` | ok except `TestMothX` — the environment item this machine's proxy already gives (red on the parent commit too, as on Nov 10); no new red |

**Branch with the commit:** [`hunt-20261112-t1-5969`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5969) (head `baca9477b137da16`). The Nov 10 branch (`verify/5969-autocompact-default`, `b80f9c108`) and its patch sha are superseded by this one.

**Patch:** <details><summary>patch: claude: a compaction share the user declared stands, the default window gives way (#5969) — git am applies it as is; SHA-256 first 16: f1b9640269dc59b0</summary>

````text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 00:03:07 +0800
Subject: [PATCH] claude: a compaction share the user declared stands, the
 default window gives way (#5969)

Claude Code compacts at the share of the window the user declared
(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, read in 2.1.285), beside the window
itself (CLAUDE_CODE_MAX_CONTEXT_TOKENS). magpie never writes the share,
so one present is the user's, yet only the window was checked: with the
share declared, magpie still wrote its default working window (272000)
into the top-level autoCompactWindow, and Desktop's Code tab showed 272K
over the declared 1M, again after every restart and after the user
deleted the field (#5969, Erfan817). The share now stands on both paths
that would hold it to the working window: the desktop plan leaves the
whole window and budget management to the user's declaration, and the
working window written for Claude Code itself gives way (#876), as to a
window the user set. A value of the user's own in the env keeps standing
when the plan is dropped, the default management coming back only when
the user clears it, as before.

TestClaudeDesktopCompactPctDeclaration and TestClaudeCompactPctGivesWay
fail without the change.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/claude.go                  |  17 ++-
 internal/agent/claude_compact_pct_test.go | 164 ++++++++++++++++++++++
 2 files changed, 178 insertions(+), 3 deletions(-)
 create mode 100644 internal/agent/claude_compact_pct_test.go

diff --git a/internal/agent/claude.go b/internal/agent/claude.go
index 7a5d20d12..9bc9ab57b 100644
--- a/internal/agent/claude.go
+++ b/internal/agent/claude.go
@@ -275,6 +275,12 @@ const claudeContextEnv = "CLAUDE_CODE_MAX_CONTEXT_TOKENS"
 // model, which Anthropic runs to its whole window.
 const claudeCompactEnv = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
 
+// claudeCompactPctEnv is the share of the window Claude Code compacts a
+// conversation at (2.1.285). magpie never writes it, so one present is
+// the user's declaration of where compaction goes: magpie's default
+// windows give way to it (#5969), as to a window the user set (#876).
+const claudeCompactPctEnv = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"
+
 // claudeOutputEnv is the longest reply Claude Code asks a model for. One it
 // doesn't know (any but Claude's own names) it asks for 32000 at most
 // (claudeUnknownOutput), whatever the model can write, so a model that
@@ -998,8 +1004,10 @@ func claudeIn(at place) *Agent {
 			// So does it to a window the user typed for the main model, on
 			// its group or its provider: Claude Code then runs to the window
 			// it is told (claudeContextEnv), as Codex is (provider.CompactFor,
-			// #1809)
-			if s.CompactAt == 0 && (claudeOwnCompact(path, main) || provider.WindowTyped(main)) {
+			// #1809). A compaction share the user declared goes first too:
+			// the env here would hold every window to the working one
+			// instead of the declared share of it (#5969)
+			if s.CompactAt == 0 && (claudeOwnCompact(path, main) || provider.WindowTyped(main) || env(claudeCompactPctEnv) != "") {
 				n = 0
 			}
 		}
@@ -1405,7 +1413,10 @@ func claudeIn(at place) *Agent {
 	// all. One the user set is theirs.
 	writeWindow := func(main string, tiers map[string]string) error {
 		budgeted = false
-		if env(claudeContextEnv) != "" && !windowOurs() {
+		// a compaction share the user declared governs the window too, so
+		// the plan's default holds it to the working window: theirs stands,
+		// as with a window of their own the plan would overwrite (#5969)
+		if (env(claudeContextEnv) != "" && !windowOurs()) || env(claudeCompactPctEnv) != "" {
 			forget(windowKey)
 			return dropBudgets()
 		}
diff --git a/internal/agent/claude_compact_pct_test.go b/internal/agent/claude_compact_pct_test.go
new file mode 100644
index 000000000..4ed594e64
--- /dev/null
+++ b/internal/agent/claude_compact_pct_test.go
@@ -0,0 +1,164 @@
+package agent
+
+import (
+	"path/filepath"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/edit"
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// pctSandbox is a HOME with provider v's glm at a 1Mi window (the kind of
+// model the user declares a big window for) and gpt at 272K.
+func pctSandbox(t *testing.T) (home, path string) {
+	home = t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
+	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	if err := provider.Save(provider.Provider{ID: "v", Name: "V", Chat: "http://127.0.0.1:1/v1", Key: "k",
+		Models: []string{"glm", "gpt"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("v", "http://127.0.0.1:1/v1", []catalog.Model{
+		{ID: "glm", Context: 1048576}, {ID: "gpt", Context: 272000},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	path = filepath.Join(home, ".claude", "settings.json")
+	writeFile(t, path, `{"theme":"dark"}`)
+	return home, path
+}
+
+// TestClaudeDesktopCompactPctDeclaration (#5969): while Claude Desktop is
+// on magpie, a user who declares where compaction goes in Claude Code's
+// settings (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a share of the window, with
+// CLAUDE_CODE_MAX_CONTEXT_TOKENS the window itself) keeps that policy:
+// magpie's default working window is not written over the top-level
+// autoCompactWindow again, on a restart or a re-apply, so Desktop runs the
+// declared window instead of showing 272K the user never chose. magpie
+// never writes the pct variable, so one present is the user's own.
+func TestClaudeDesktopCompactPctDeclaration(t *testing.T) {
+	home, path := pctSandbox(t)
+	a := claude(home)
+	window := func() string { v, _ := edit.GetJSON(path, "env."+claudeContextEnv); return v }
+	pct := func() string { v, _ := edit.GetJSON(path, "env."+claudeCompactPctEnv); return v }
+	top := func() string { v, _ := edit.GetJSON(path, "autoCompactWindow"); return v }
+	def := func() string { return stashShared()["claude.compact_default"] }
+
+	// magpie's desktop plan first: the largest window is told, the
+	// working window goes in the top-level autoCompactWindow
+	if err := claudeDesktop(home).Field("provider").Set("magpie"); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Field("model").Set("v/glm"); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if window() != "1048576" || top() != "272000" {
+		t.Fatalf("wired: window %q top %q", window(), top())
+	}
+	if def() != "272000" {
+		t.Fatalf("wired: stash compact_default %q", def())
+	}
+
+	// the user declares the policy in Claude Code's settings: the window
+	// they run (the one magpie wrote is the same 1Mi they declare) and
+	// compaction at a share of it; the top-level default they delete
+	if err := edit.SetJSON(path,
+		edit.KV{Path: "env." + claudeCompactPctEnv, Value: "80"},
+	); err != nil {
+		t.Fatal(err)
+	}
+	if err := edit.DelJSON(path, "autoCompactWindow"); err != nil {
+		t.Fatal(err)
+	}
+
+	// Desktop restarts, magpie applies again: the declaration stands, the
+	// default does not come back
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if v := top(); v != "" {
+		t.Fatalf("the deleted top-level autoCompactWindow was written again: %q", v)
+	}
+	if def() != "" {
+		t.Fatalf("stash compact_default %q came back", def())
+	}
+	if window() != "1048576" || pct() != "80" {
+		t.Fatalf("the user's declaration was touched: window %q pct %q", window(), pct())
+	}
+	if v, _ := edit.GetJSON(path, "env."+claudeCompactEnv); v != "" {
+		t.Fatalf("%s %q would overrule the declared share", claudeCompactEnv, v)
+	}
+
+	// without the declaration, the window value in the env is the user's
+	// own now (magpie's mark went with the dropped plan), and stands: the
+	// default management stays out while it does, and comes back once the
+	// user clears the env too, as with any value of theirs
+	if err := edit.DelJSON(path, "env."+claudeCompactPctEnv); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if top() != "" || window() != "1048576" {
+		t.Fatalf("the user's window value stands: top %q window %q", top(), window())
+	}
+	if err := edit.DelJSON(path, "env."+claudeContextEnv); err != nil {
+		t.Fatal(err)
+	}
+	if err := a.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if top() != "272000" || window() != "1048576" {
+		t.Fatalf("default management back: top %q window %q", top(), window())
+	}
+}
+
+// TestClaudeCompactPctGivesWay (#5969): Claude Code compacts at the share
+// of the window the user declared (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE), so
+// magpie's default working window gives way to it (#876), as to a window
+// the user typed: no CLAUDE_CODE_AUTO_COMPACT_WINDOW is written while the
+// declaration is there, and the user's variable is never touched.
+func TestClaudeCompactPctGivesWay(t *testing.T) {
+	home, path := pctSandbox(t)
+	a := claude(home)
+	compact := func() string { v, _ := edit.GetJSON(path, "env."+claudeCompactEnv); return v }
+	pct := func() string { v, _ := edit.GetJSON(path, "env."+claudeCompactPctEnv); return v }
+	must := func(err error) {
+		t.Helper()
+		if err != nil {
+			t.Fatal(err)
+		}
+	}
+
+	// the default first: the working window
+	must(a.Field("model").Set("v/glm"))
+	if compact() != "272000" {
+		t.Fatalf("on magpie: %q", compact())
+	}
+
+	// the user declares a share of the window: magpie's own default goes,
+	// the declaration stands
+	must(edit.SetJSON(path, edit.KV{Path: "env." + claudeCompactPctEnv, Value: "80"}))
+	must(a.Sync())
+	if compact() != "" {
+		t.Fatalf("declared share held to the working window: %q", compact())
+	}
+	if pct() != "80" {
+		t.Fatalf("the user's variable was touched: %q", pct())
+	}
+
+	// the declaration gone, the default is written again
+	must(edit.DelJSON(path, "env."+claudeCompactPctEnv))
+	must(a.Sync())
+	if compact() != "272000" {
+		t.Fatalf("declaration gone: %q", compact())
+	}
+}
-- 
2.50.1 (Apple Git-155)
````

</details>

Not verified, as before: a real Windows Desktop restart on a used-up plan — the fixture carries the reporter's file state byte for byte, and their same-second timestamps remain the on-machine evidence.

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.


