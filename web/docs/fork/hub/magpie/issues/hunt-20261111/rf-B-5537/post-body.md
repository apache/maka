Refreshed on current `main` (`729664580`) — refreshed, not redesigned: same change (a relay's claude-* model compacts like any other model's instead of being read as one of Anthropic's own), cherry-picked clean onto today's tip.

**Red without the fix** (bare `729664580`, the tests from this branch): the compact-window judgment treats a relay's claude model as Anthropic's own:

```
--- FAIL: TestClaudeCompactWindow
--- FAIL: TestClaudeCompactAt
--- FAIL: TestClaudeCompactWindowRelayClaude
```

With the fix: all `ok` — the relay model gets a compact window like any other model's, and the full agent package passes but for `TestMothX` (in the pre-existing reds list, red on the bare base too).

**Verification** (all on `729664580`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/agent -run 'TestClaudeCompactWindowRelayClaude'` | ok |
| full `go test ./internal/agent` | one failure, `TestMothX` — the pre-existing red, red on the bare base too |
| `gofmt` / `go vet` | clean |
| `GOOS=linux go build -tags nogui ./internal/agent` | ok |
| ablation (the `claudeOfficial` hunks reverse-applied, tests kept) | red again at the same three tests; restored, green |
| `git am` on detached `729664580^` | applies as is; tree identical to the branch head |

**Siblings**: the four compact-window sites now ask `claudeOfficial` (writes the compact-at, the per-model window, the group's, the tiers'). The five `claudeModel` (name-family) callers that stay are the client-shape faces, on purpose: the `/model` picker's grouping (:1371/:1380), the `[1m]` long-main mark's own face (`claudeLongMain`, upstream's #magicalaciw18 run-to-1M), and the output-tokens Claude Code is told (:2919/:2928) — all judge what Claude Code recognises by name, not whose endpoint serves it.

**Branch with the commit**: [hunt-20261111-rf-5537](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5537) (head `bc8892e84ab2ed5f`).

**Not verified**: Claude Code 2.1.159+ against a real relay (the 400-past-272K shape the report shows is pinned by the three tests).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: claude: a relay's claude model compacts like any other model's (#5537) — git am applies it as is; SHA-256 first 16: cd75320be2b459e2</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 7 Nov 2026 03:52:02 +0800
Subject: [PATCH] claude: a relay's claude model compacts like any other
 model's (#5537)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

Claude Code 2.1.159 auto-compacts a local session only when an
auto-compact window is set (anthropics/claude-code#64520), and it knows
no window for the prefixed id magpie hands it — but magpie wrote none
for a claude-named model, judging Anthropic's own by the name alone:
Claude Code was left nothing that compacts, and a long conversation ran
until every turn was a 400 "Context window is full", the compaction
request as oversized as the history it carries (#5537, 99iii).

claudeOfficial judges by the provider: api.anthropic.com, its Claude
subscription, Bedrock or Vertex still runs to its own; a relay's or
another subscription's claude model gets the working window as any
other model does, a threshold set on it or its provider first (#876).
Under the per-model budgets (Claude Desktop's plan) the working window
serves as the top-level autoCompactWindow, so models whose own is that
one have no entry beside it, as claudePlan already serves them.

Fixes #5537
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/claude.go              | 44 +++++++++---
 internal/agent/claude_compact_test.go | 96 +++++++++++++++++++++++++--
 internal/agent/window_typed_test.go   | 12 +++-
 3 files changed, 133 insertions(+), 19 deletions(-)

diff --git a/internal/agent/claude.go b/internal/agent/claude.go
index 0f9898a78..e698785de 100644
--- a/internal/agent/claude.go
+++ b/internal/agent/claude.go
@@ -972,8 +972,8 @@ func claudeIn(at place) *Agent {
 	budgeted := false
 	// writeCompact has Claude Code compact at the working window
 	// (settings.WorkingWindow) on magpie, unless settings.FullContext or the
-	// main model is one of Anthropic's Claude models: Anthropic runs a [1m]
-	// one to its whole 1M, so it gets its own window (Max on Discord: a
+	// main model is one of Anthropic's own Claude models: Anthropic runs a
+	// [1m] one to its whole 1M, so it gets its own window (Max on Discord: a
 	// [1m] model stopped at 272K), or a routing group made only of
 	// them (provider.ClaudeGroup, #1741)
 	writeCompact := func() error {
@@ -990,7 +990,7 @@ func claudeIn(at place) *Agent {
 		main := mainModel()
 		n := provider.CompactSet(main)
 		long := false
-		if s := settings.Load().ForAgent("claude"); n == 0 && !claudeModel(main) && !provider.ClaudeGroup(main) {
+		if s := settings.Load().ForAgent("claude"); n == 0 && !claudeOfficial(main) && !provider.ClaudeGroup(main) {
 			n, long = s.Compact(), true
 			// magpie's default gives way to an autoCompactWindow the user
 			// set in Claude Code (/autocompact, its settings), which the env
@@ -1272,8 +1272,9 @@ func claudeIn(at place) *Agent {
 		userTop = userTop && !defaultOurs()
 		// the window each model of magpie's compacts at (claudeBudget's
 		// compact), as writeCompact gives the main model: the user's
-		// threshold for it first (#876); a Claude model, or a group of them,
-		// runs to its own (#1741), as does one whose window the user typed
+		// threshold for it first (#876); one of Anthropic's own Claude
+		// models, or a group of them, runs to its own (#1741), as does one
+		// whose window the user typed
 		// (#1809); the user's autoCompactWindow, unless they gave magpie a
 		// threshold for every model; then that one, the working window
 		// unless Full window. It is the model's own entry, so Desktop's
@@ -1283,7 +1284,7 @@ func claudeIn(at place) *Agent {
 			if n := provider.CompactSet(ref); n > 0 {
 				return n
 			}
-			if claudeModel(ref) || provider.ClaudeGroup(ref) {
+			if claudeOfficial(ref) || provider.ClaudeGroup(ref) {
 				return -1
 			}
 			if s.CompactAt == 0 && userTop {
@@ -1323,14 +1324,15 @@ func claudeIn(at place) *Agent {
 			for _, v := range refs {
 				m, _ := tierAt(v)
 				bare := strings.TrimSuffix(m, "[1m]")
-				if v == "" || claudeModel(bare) || provider.ClaudeGroup(bare) {
+				if v == "" || claudeOfficial(bare) || provider.ClaudeGroup(bare) {
 					continue
 				}
 				models = append(models, claudeBudget{id: spell(v), window: window[bare], long: strings.HasSuffix(v, "[1m]"), compact: work(bare)})
 			}
 			// the one for every model else, as the variable gave it: none
-			// on a Claude main model, which Anthropic runs to its own
-			if m, _ := tierAt(main); !claudeModel(strings.TrimSuffix(m, "[1m]")) && !provider.ClaudeGroup(strings.TrimSuffix(m, "[1m]")) {
+			// on a Claude main model of Anthropic's own, which Anthropic
+			// runs to its own
+			if m, _ := tierAt(main); !claudeOfficial(strings.TrimSuffix(m, "[1m]")) && !provider.ClaudeGroup(strings.TrimSuffix(m, "[1m]")) {
 				def = s.Compact()
 			}
 		}
@@ -2797,6 +2799,30 @@ func claudeModel(ref string) bool {
 	return provider.ClaudeModel(strings.TrimSuffix(ref, "[1m]"))
 }
 
+// claudeOfficial says ref names one of Anthropic's own Claude models, on a
+// provider Anthropic serves itself — api.anthropic.com, its Claude
+// subscription, Bedrock or Vertex. A relay's or another subscription's
+// claude model is not, whatever its name: Claude Code knows no window for
+// the prefixed id magpie hands it, and since 2.1.159 nothing auto-compacts
+// a local session unless an auto-compact window is set
+// (anthropics/claude-code#64520), so without one a long conversation runs
+// until every turn is a 400 "Context window is full" (#5537). A model no
+// provider of magpie's answers for is told a window as any other model's.
+func claudeOfficial(ref string) bool {
+	if !claudeModel(ref) {
+		return false
+	}
+	pid, _, ok := strings.Cut(ref, "/")
+	if !ok || pid == "" {
+		return true // Claude Code's own pick, on Anthropic's own endpoint
+	}
+	p, err := provider.Find(pid)
+	if err != nil {
+		return false
+	}
+	return provider.HostOf(p.Anthropic) == "api.anthropic.com" || p.IsBedrock() || p.IsVertex()
+}
+
 // claudeOwnCompact says the settings.json at path has an auto-compact
 // window of the user's for model: autoCompactWindow, or one under
 // modelSettings for it (as /autocompact saves it), a number or "auto".
diff --git a/internal/agent/claude_compact_test.go b/internal/agent/claude_compact_test.go
index 1945618ba..ecd286b57 100644
--- a/internal/agent/claude_compact_test.go
+++ b/internal/agent/claude_compact_test.go
@@ -28,6 +28,13 @@ func TestClaudeCompactWindow(t *testing.T) {
 	if err := catalog.SaveLive("v", "https://example.test/v1", []catalog.Model{{ID: "big", Context: 1000000}, {ID: "claude-opus-5-5", Context: 1000000}}); err != nil {
 		t.Fatal(err)
 	}
+	if err := provider.Save(provider.Provider{ID: "an", Name: "Anthropic", Anthropic: "https://api.anthropic.com", Key: "k",
+		Models: []string{"claude-opus-5-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("an", "https://api.anthropic.com", []catalog.Model{{ID: "claude-opus-5-5", Context: 1000000}}); err != nil {
+		t.Fatal(err)
+	}
 	path := filepath.Join(home, ".claude", "settings.json")
 	writeFile(t, path, `{}`)
 	a := claude(home)
@@ -53,10 +60,11 @@ func TestClaudeCompactWindow(t *testing.T) {
 	if compact() != "272000" {
 		t.Fatalf("back to the working window: %q", compact())
 	}
-	// a Claude model runs to its whole window, as Anthropic runs a [1m]
-	// one (Max on Discord: a [1m] model stopped at 272K), and another
-	// vendor's is capped again after it
-	must(a.Field("model").Set("v/claude-opus-5-5[1m]"))
+	// a Claude model of Anthropic's own runs to its whole window, as
+	// Anthropic runs a [1m] one (Max on Discord: a [1m] model stopped at
+	// 272K), and one a relay serves is capped again like any other
+	// model's (#5537)
+	must(a.Field("model").Set("an/claude-opus-5-5[1m]"))
 	if compact() != "" {
 		t.Fatalf("a Claude model: %q", compact())
 	}
@@ -64,6 +72,10 @@ func TestClaudeCompactWindow(t *testing.T) {
 	if compact() != "" {
 		t.Fatalf("a Claude model, synced: %q", compact())
 	}
+	must(a.Field("model").Set("v/claude-opus-5-5[1m]"))
+	if compact() != "272000" {
+		t.Fatalf("a relay's Claude model: %q", compact())
+	}
 	must(a.Field("model").Set("v/big[1m]"))
 	if compact() != "272000" {
 		t.Fatalf("after a Claude model: %q", compact())
@@ -145,7 +157,7 @@ func TestClaudeCompactAt(t *testing.T) {
 	expect("a Claude model, its provider's", "600000")
 	must(provider.SetModelCompacts("v", map[string]int{"flash": 200000}))
 	must(a.Sync())
-	expect("a Claude model, none set", "")
+	expect("a relay's Claude model, every model's", "400000")
 	must(provider.SetFullContext(true))
 	must(a.Field("model").Set("v/flash"))
 	expect("full window, the model's own", "200000")
@@ -301,6 +313,75 @@ func TestClaudeGroupCompactWindow(t *testing.T) {
 	}
 }
 
+// A claude model a relay serves is not one of Anthropic's, whatever its
+// name: Claude Code knows no window for the prefixed id magpie hands it,
+// and since 2.1.159 nothing auto-compacts a local session unless an
+// auto-compact window is set (anthropics/claude-code#64520), so a long
+// conversation ran until every turn was a 400 "Context window is full",
+// the compaction request as oversized as the history it carries (#5537,
+// 99iii). magpie tells the window as it does any other model's: the
+// working window, a threshold set on the model's provider first (#876).
+// One of Anthropic's own, on api.anthropic.com, still runs to its own.
+func TestClaudeCompactWindowRelayClaude(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	if err := provider.Save(provider.Provider{ID: "v", Name: "V", Chat: "https://example.test/v1", Key: "k",
+		Models: []string{"claude-opus-5-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("v", "https://example.test/v1", []catalog.Model{{ID: "claude-opus-5-5", Context: 1000000}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := provider.Save(provider.Provider{ID: "an", Name: "Anthropic", Anthropic: "https://api.anthropic.com", Key: "k",
+		Models: []string{"claude-opus-5-5"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := catalog.SaveLive("an", "https://api.anthropic.com", []catalog.Model{{ID: "claude-opus-5-5", Context: 1000000}}); err != nil {
+		t.Fatal(err)
+	}
+	path := filepath.Join(home, ".claude", "settings.json")
+	writeFile(t, path, `{}`)
+	a := claude(home)
+	compact := func() string { v, _ := edit.GetJSON(path, "env."+claudeCompactEnv); return v }
+	must := func(err error) {
+		t.Helper()
+		if err != nil {
+			t.Fatal(err)
+		}
+	}
+	expect := func(what, want string) {
+		t.Helper()
+		if got := compact(); got != want {
+			t.Fatalf("%s: %q; want %q", what, got, want)
+		}
+	}
+
+	must(a.Field("model").Set("v/claude-opus-5-5"))
+	expect("a relay's claude model", "272000")
+	must(a.Field("model").Set("v/claude-opus-5-5[1m]"))
+	expect("a relay's claude [1m] model", "272000")
+	must(a.Sync())
+	expect("a relay's claude [1m] model, synced", "272000")
+	// a threshold set on the relay comes first, as for any other model
+	must(provider.SetModelCompacts("v", map[string]int{"*": 600000}))
+	must(a.Sync())
+	expect("a relay's claude model, its provider's", "600000")
+	must(provider.SetModelCompacts("v", nil))
+	must(a.Sync())
+	expect("back to the working window", "272000")
+	// one of Anthropic's own runs to its own
+	must(a.Field("model").Set("an/claude-opus-5-5[1m]"))
+	expect("Anthropic's own [1m]", "")
+	must(a.Field("model").Set("an/claude-opus-5-5"))
+	expect("Anthropic's own", "")
+	// back on the relay, the window is told again
+	must(a.Field("model").Set("v/claude-opus-5-5"))
+	expect("back on the relay", "272000")
+}
+
 // A Claude model runs to its whole window whatever name its provider gives
 // it: Amazon Bedrock names Claude Opus us.anthropic.claude-…, which
 // magpie's [1m] Claude Opus there was not taken for, so Claude Code was
@@ -314,11 +395,12 @@ func TestClaudeCompactWindowBedrockClaude(t *testing.T) {
 	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
 	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
 	const opus, nova = "us.anthropic.claude-opus-5-5-v1", "us.amazon.nova-premier-v1"
-	if err := provider.Save(provider.Provider{ID: "br", Name: "Bedrock", Chat: "https://example.test/v1", Key: "k",
+	if err := provider.Save(provider.Provider{ID: "br", Name: "Bedrock", Preset: "bedrock",
+		Anthropic: "https://bedrock-runtime.us-east-1.amazonaws.com", Key: "k",
 		Models: []string{opus, nova}}); err != nil {
 		t.Fatal(err)
 	}
-	if err := catalog.SaveLive("br", "https://example.test/v1", []catalog.Model{{ID: opus, Context: 1000000}, {ID: nova, Context: 1000000}}); err != nil {
+	if err := catalog.SaveLive("br", "https://bedrock-runtime.us-east-1.amazonaws.com", []catalog.Model{{ID: opus, Context: 1000000}, {ID: nova, Context: 1000000}}); err != nil {
 		t.Fatal(err)
 	}
 	path := filepath.Join(home, ".claude", "settings.json")
diff --git a/internal/agent/window_typed_test.go b/internal/agent/window_typed_test.go
index 63069cf71..fd7104bf3 100644
--- a/internal/agent/window_typed_test.go
+++ b/internal/agent/window_typed_test.go
@@ -265,7 +265,7 @@ func TestPickerModelsTheirOwnWindow(t *testing.T) {
 	a := claude(home)
 	env := func(k string) string { v, _ := edit.GetJSON(path, "env."+k); return v }
 	budget := func(id string) string { v, _ := edit.GetJSON(path, budgetPath(id)); return v }
-	check := func(name string, want map[string]string) {
+	check := func(name string, top string, want map[string]string) {
 		t.Helper()
 		// glm is 1M, marked [1m] in /model: the window told
 		if w := env(claudeContextEnv); w != "1000000" {
@@ -274,14 +274,20 @@ func TestPickerModelsTheirOwnWindow(t *testing.T) {
 		if c := env(claudeCompactEnv); c != "" {
 			t.Errorf("%s: %s is %q, which would hold every model to it", name, claudeCompactEnv, c)
 		}
+		if v, _ := edit.GetJSON(path, "autoCompactWindow"); v != top {
+			t.Errorf("%s: top-level autoCompactWindow %q; want %q", name, v, top)
+		}
 		for id, w := range want {
 			if v := budget(id); v != w {
 				t.Errorf("%s: %s in /model compacts at %q; want %q", name, id, v, w)
 			}
 		}
 	}
+	// the main is a relay's claude model (#5537), which the working window
+	// serves as the top-level autoCompactWindow: a model whose own is that
+	// one has no entry of its own beside it
 	must(a.Field("model").Set("a/claude-opus-5-5"))
-	check("a Claude main", map[string]string{"group/mix": "272000", "w/gpt-6.1-sol": "272000", "v/grok": "256000", "v/gpt": "272000"})
+	check("a Claude main", "272000", map[string]string{"group/mix": "", "w/gpt-6.1-sol": "", "v/grok": "256000", "v/gpt": ""})
 	// beside a main whose window is told, a /model pick runs at that one
 	// value, as before
 	must(a.Field("model").Set("v/grok"))
@@ -297,5 +303,5 @@ func TestPickerModelsTheirOwnWindow(t *testing.T) {
 	must(settings.Save(s))
 	SyncCatalog()
 	must(a.Field("model").Set("a/claude-opus-5-5"))
-	check("Full window", map[string]string{"group/mix": "500000", "w/gpt-6.1-sol": "500000", "v/grok": "256000", "v/gpt": "272000"})
+	check("Full window", "", map[string]string{"group/mix": "500000", "w/gpt-6.1-sol": "500000", "v/grok": "256000", "v/gpt": "272000"})
 }
-- 
2.50.1 (Apple Git-155)

```
</details>
