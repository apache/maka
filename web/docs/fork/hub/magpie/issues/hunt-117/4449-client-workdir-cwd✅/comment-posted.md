Fixed on `ggbdpq/magpie` branch [`fix/4449-client-workdir-cwd`](https://github.com/ggbdpq/magpie/tree/fix/4449-client-workdir-cwd) (head `f202c508f`, base `5daba8337`).

**What was wrong**

`clientNamedWorkPlace` (`internal/gateway/claude_subscription.go:515`) took the *last* working-directory line anywhere in the request — system prompt first, then every non-assistant text part. So:

1. `claude --bare` states its folder as `CWD: /x`, which `clientCwdPattern` never matched: a bare caller named nothing, so every run fell back to `claudeWorkDir()` (P1).
2. A user turn that merely quoted a working-directory line overrode the caller's own line when the quote sat alone on its line and named a folder that exists (P3), and broke the capture — the run fell back to the shared folder — when it didn't (P4, P5).
3. The bridge reads the request as masking left it: a word of the folder the redact rules take (P11: a directory named for the user) stands in it as a placeholder, `os.Stat` fails, and the run falls back to the shared folder with the `envElsewhere` note added. The routing row's `folder` holds the real path, so the log looks right while the run is elsewhere.
4. One more, same family: `Primary working directory: /y (was /x)` was captured with its ` (was /x)` tail, so a caller that had moved failed `os.Stat` and fell back too.

**The fix**

What the caller itself says wins over what a turn of the conversation says — `req.System` and the caller's `{role: "system"}` messages are read first, and a turn is read only where a caller states its folder in one (Codex's `<environment_context>` is one of the user's, OpenCode's `<env>` a later message). Claude Code states its folder in its instructions or in a system message of its own, and `CWD:` is a `--bare` run's whole system prompt, so their forms are never read in a turn: a line a user message quotes is no caller's word. All forms are anchored at line start now, `CWD:` is matched in the caller's own layer, and the ` (was /x)` tail is stripped as the routing rules (`ccWorkDir` in `workdir.go`) already strip it. A named folder that is not on disk is unmasked (`restored`) before it is looked for — the same restore the search query already gets (`search_mcp.go`). I did not take the "fall back to the last *usable* named folder" suggestion: with the caller's own layer winning, no probe in the matrix hits that case (P3/P4/P5 all resolve through the caller's layer).

**Verification**

| Check | Command | Result |
| --- | --- | --- |
| New tests, all probes (P1-P5, the environment message, the `was` form, Codex/OpenCode in a turn, the masked path) | `go test ./internal/gateway -run 'TestClaudeRunsWhereTheCallerRunsNotWhereATurnQuotes\|TestClaudeRunsInTheFolderAMaskedPathNames' -count=1` | 6 subtests red before (P1, P3, P4, P5, environment message, `was`; plus the masked-path test), all green after |
| Red without the fix | product file reverted to `5daba8337`, new tests kept | both new tests fail (shared folder / the quoted folder), green again with the fix |
| Regression, the callers' folders and their sessions | `go test ./internal/gateway -run 'TestClaude\|TestWorkDir\|TestPlugin' -count=1` | ok (117.8s) |
| Race | same targeted set, `-race` | ok (99.9s) |
| Full gateway suite | `go test ./internal/gateway -tags nogui -count=1 -timeout 25m` | one FAIL: `TestCodexPoolSaysTheClientsVersion` (655s); solo `-count=3` ok, and the baseline `5daba8337` suite fails the same single test (569s) |
| gofmt / vet / build | `gofmt -l`; `go vet` for linux, windows, darwin; `go build -tags nogui` for linux, windows, darwin | clean, clean, all three build |

The full suite takes ~10 minutes, which is what the first run's 10-minute `panic: test timed out` was — the baseline shows the same.

**Siblings**: `workDirIn`/`ccWorkDir` (`workdir.go`) read the same lines for routing-group rules by folder. Left as is: a quoted line steering a *routing* rule is a different decider than the folder the run works in, and this issue reports the run folder. `clientCwdPattern` is gone — replaced by `clientSaidWorkDir`/`clientTurnWorkDir`, no references left.

**When the read fails**: `os.Stat` on the named folder failing now tries the unmasked path first; with no masker serving, or a placeholder the masker no longer knows, `restored` returns the path as it is and the run falls back to `claudeWorkDir()` as before.

**Not verified**: a real `claude --bare` caller against a real gateway (the tests stand a shell script in for Claude Code); the probe matrix is the reporter's, reproduced at the test seam.

---
**Red without the fix** (base `5daba8337`): with `internal/gateway/claude_subscription.go` reverted and the new tests kept, `go test ./internal/gateway -run 'TestClaudeRunsWhereTheCallerRunsNotWhereATurnQuotes|TestClaudeRunsInTheFolderAMaskedPathNames'` fails:
```
--- FAIL: TestClaudeRunsWhereTheCallerRunsNotWhereATurnQuotes (2.26s)
--- FAIL: TestClaudeRunsInTheFolderAMaskedPathNames (0.19s)
```
With the fix: `ok`.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: claude: the run works in the caller's folder a turn quotes over, a --bare CWD: line misses, and a masked path breaks (#4449) — git am applies it as is; SHA-256 first 16: 89109dc9bf505b96</summary>

```patch
From f202c508f5c1aab5bded85a40ad53ed6314ca531 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 20:42:18 +0800
Subject: [PATCH] claude: the run works in the caller's folder a turn quotes
 over, a --bare CWD: line misses, and a masked path breaks (#4449)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

clientNamedWorkPlace took the last working-directory line anywhere in the
request, so a user turn that merely quoted one ("Primary working
directory: /x", alone on its line or inside a longer one) overrode the
caller's own, or broke the capture and fell back to magpie's shared
folder; and claude --bare states its folder as "CWD: /x", which the
pattern never matched, so a --bare caller always worked in the shared
folder while being told it was theirs. A word of the folder the redact
rules mask stands in the request as a placeholder, which names no folder
on disk: the run fell back to the shared folder, and a file written by
absolute path went there for later, unrelated sessions to find.

The caller's own word wins now: its instructions and its system messages
are read first (all the forms, "CWD:" included, on a line of their own),
and a turn is read only where a caller states its folder in one (Codex's
<environment_context>, OpenCode's <env>) — a line quoted from Claude
Code's instructions is never one of those. "Primary working directory:
/y (was /x)" is read as /y, as the routing rules already read it. A
named folder that isn't on disk is unmasked before it is looked for.

Fixes #4449
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/claude_subscription.go |  79 ++++++++++---
 internal/gateway/claude_workdir_test.go | 149 ++++++++++++++++++++++--
 2 files changed, 207 insertions(+), 21 deletions(-)

diff --git a/internal/gateway/claude_subscription.go b/internal/gateway/claude_subscription.go
index 86e7cb156..4a04bc412 100644
--- a/internal/gateway/claude_subscription.go
+++ b/internal/gateway/claude_subscription.go
@@ -492,12 +492,13 @@ func claudeWorkDir() (string, error) {
 	return dir, nil
 }
 
-// clientWorkDir is the working directory the caller's instructions name,
-// the last one they name, as Claude Code ("Primary working directory:"),
-// Codex (<cwd>), OpenCode ("Working directory:") and pi ("Current working
-// directory:") write it; "" when they name none, or one that isn't an
-// absolute path to a folder on this computer (a caller elsewhere). The
-// model's own words are not read: what it says is no caller's.
+// clientWorkDir is the working directory the caller names, the last one
+// it names, as Claude Code ("Primary working directory:", or just "CWD:"
+// on a --bare run), Codex (<cwd>), OpenCode ("Working directory:") and pi
+// ("Current working directory:") write it; "" when they name none, or one
+// that isn't an absolute path to a folder on this computer (a caller
+// elsewhere). The model's own words are not read: what it says is no
+// caller's.
 func clientWorkDir(req *Request) string {
 	dir := clientNamedWorkDir(req)
 	if dir == "" || !filepath.IsAbs(dir) {
@@ -505,7 +506,17 @@ func clientWorkDir(req *Request) string {
 	}
 	dir = filepath.Clean(dir)
 	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
-		return ""
+		// what the caller named may be masked: a word of the folder the
+		// redact rules take stands in the request as a placeholder, and
+		// a placeholder names no folder on disk. The folder is the one
+		// unmasked, the caller's own.
+		if u := restored(dir, false); u == dir {
+			return ""
+		} else if fi, err = os.Stat(u); err != nil || !fi.IsDir() {
+			return ""
+		} else {
+			dir = filepath.Clean(u)
+		}
 	}
 	return dir
 }
@@ -522,31 +533,71 @@ func clientNamedWorkDir(req *Request) string {
 // 2.1.296 and later give their environment as a {role: "system"} message
 // after the user's first, so the run is told it in the conversation,
 // after the caller's instructions (envTurnsNote).
+//
+// What the caller itself says wins over what a turn of the conversation
+// says: a user turn that quotes a working-directory line ("Primary
+// working directory: /x", alone on its line or inside a longer one) is no
+// caller's word. Only the forms a caller states in a turn are read there
+// (Codex's <environment_context> is one of the user's, OpenCode's <env> a
+// later message), and a line quoted from Claude Code's own words — its
+// instructions or a --bare run's "CWD:" — is never one of them.
 func clientNamedWorkPlace(req *Request) (dir string, inTurns bool) {
-	look := func(t string, turn bool) {
-		for _, m := range clientCwdPattern.FindAllStringSubmatch(t, -1) {
+	look := func(t string, turn bool, re *regexp.Regexp) {
+		for _, m := range re.FindAllStringSubmatch(t, -1) {
 			for _, g := range m[1:] {
-				if g = strings.Trim(strings.TrimSpace(g), "`'\""); g != "" {
+				g = strings.Trim(strings.TrimSpace(g), "`'\"")
+				if g = wasDir.ReplaceAllString(g, ""); g != "" {
 					dir, inTurns = g, turn
 				}
 			}
 		}
 	}
-	look(req.System, false)
+	// the caller's own: its instructions, then a system message of its
+	// own, which says so after
+	look(req.System, false, clientSaidWorkDir)
 	for _, m := range req.Messages {
-		if m.Role == "assistant" {
+		if m.Role != "system" {
+			continue
+		}
+		for _, p := range m.Parts {
+			if p.Kind == Text {
+				look(p.Text, true, clientSaidWorkDir)
+			}
+		}
+	}
+	if dir != "" {
+		return dir, inTurns
+	}
+	// what a caller states in a turn, which its own instructions and
+	// Claude Code's lines are never part of
+	for _, m := range req.Messages {
+		if m.Role == "assistant" || m.Role == "system" {
 			continue
 		}
 		for _, p := range m.Parts {
 			if p.Kind == Text {
-				look(p.Text, true)
+				look(p.Text, true, clientTurnWorkDir)
 			}
 		}
 	}
 	return dir, inTurns
 }
 
-var clientCwdPattern = regexp.MustCompile(`(?m)(?:Primary working directory|^\s*(?:-\s*)?Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)</cwd>`)
+// clientSaidWorkDir is where the caller itself says its working directory
+// is, on a line of its own: Claude Code's, in its instructions (" - Primary
+// working directory: /x", a moved folder as "Primary working directory: /y
+// (was /x)"), on a --bare run just "CWD: /x"; OpenCode's, in its <env>;
+// pi's ("Current working directory:"); Codex's and pi's <cwd>.
+var clientSaidWorkDir = regexp.MustCompile(`(?m)^\s*(?:-\s*)?(?:Primary working directory|Working directory|Current working directory|CWD): *([^\r\n]+)$|<cwd>([^<\r\n]+)</cwd>`)
+
+// clientTurnWorkDir is where a caller says its working directory is in a
+// turn of the conversation, on a line of its own: Codex's
+// <environment_context> is one of the user's, OpenCode's <env> a later
+// message. Claude Code states its folder in its instructions or a system
+// message of its own, and --bare's "CWD:" is its whole system prompt, so
+// their forms are not read in a turn: a line a user message quotes —
+// Claude Code's or anyone's — is no caller's word.
+var clientTurnWorkDir = regexp.MustCompile(`(?m)^\s*(?:-\s*)?(?:Working directory|Current working directory): *([^\r\n]+)$|<cwd>([^<\r\n]+)</cwd>`)
 
 func evalSymlinks(path string) string {
 	if p, err := filepath.EvalSymlinks(path); err == nil {
diff --git a/internal/gateway/claude_workdir_test.go b/internal/gateway/claude_workdir_test.go
index c57488aa5..6a8c875ef 100644
--- a/internal/gateway/claude_workdir_test.go
+++ b/internal/gateway/claude_workdir_test.go
@@ -1,6 +1,7 @@
 package gateway
 
 import (
+	"context"
 	"encoding/json"
 	"net/http/httptest"
 	"os"
@@ -10,7 +11,10 @@ import (
 	"testing"
 	"time"
 
+	"github.com/yetone/magpie/internal/gwmw"
+	"github.com/yetone/magpie/internal/masking"
 	"github.com/yetone/magpie/internal/provider"
+	"github.com/yetone/magpie/internal/settings"
 	"github.com/yetone/magpie/internal/testenv"
 )
 
@@ -35,6 +39,18 @@ func claudeWorkDirsTold(t *testing.T, prepare func(work string), system func(hom
 // claudeWorkDirsFrom is claudeWorkDirsTold with the requests from the
 // address from ("" for httptest's, another computer's).
 func claudeWorkDirsFrom(t *testing.T, from string, prepare func(work string), system func(home string) string) (dirs []string, work string, s *Server, env, told string) {
+	t.Helper()
+	return claudeWorkDirsBody(t, from, prepare, func(home string) string {
+		rules, _ := json.Marshal(system(home))
+		return `{"model":"claude-sonnet-5","max_tokens":100,"system":` + string(rules) + `,"messages":[{"role":"user","content":"one"},{"role":"user","content":"two"}]}`
+	})
+}
+
+// claudeWorkDirsBody is claudeWorkDirsFrom with the whole request body
+// given: it is sent twice, and it gives the folders the two runs worked
+// in, the gateway, and the environment and instructions the runs were
+// told.
+func claudeWorkDirsBody(t *testing.T, from string, prepare func(work string), body func(home string) string) (dirs []string, work string, s *Server, env, told string) {
 	t.Helper()
 	if runtime.GOOS == "windows" {
 		t.Skip("a shell script stands in for Claude Code")
@@ -68,23 +84,22 @@ done
 
 	s = New()
 	p := provider.Provider{ID: "claude", Account: &provider.Account{Agent: "claude", User: "u"}}
-	rules, _ := json.Marshal(system(home))
-	for _, said := range []string{"one", "two"} {
-		body := `{"model":"claude-sonnet-5","max_tokens":100,"system":` + string(rules) + `,"messages":[{"role":"user","content":"` + said + `"}]}`
+	b := body(home)
+	for range 2 {
 		rec := httptest.NewRecorder()
 		var u Usage
-		r := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(body))
+		r := httptest.NewRequest("POST", "/v1/messages", strings.NewReader(b))
 		if from != "" {
 			r.RemoteAddr = from
 		}
-		if code, msg := s.serveClaudeSubscription(rec, r, provider.Anthropic, p, "claude-sonnet-5", []byte(body), &u); code != 200 {
+		if code, msg := s.serveClaudeSubscription(rec, r, provider.Anthropic, p, "claude-sonnet-5", []byte(b), &u); code != 200 {
 			t.Fatalf("%d %s", code, msg)
 		}
 	}
-	b, _ := os.ReadFile(filepath.Join(dir, "dirs"))
+	bb, _ := os.ReadFile(filepath.Join(dir, "dirs"))
 	e, _ := os.ReadFile(filepath.Join(dir, "env"))
 	m, _ := os.ReadFile(filepath.Join(dir, "told"))
-	return strings.Fields(string(b)), evalSymlinks(work), s, string(e), string(m)
+	return strings.Fields(string(bb)), evalSymlinks(work), s, string(e), string(m)
 }
 
 // Every run works in the same folder: Claude Code puts its working
@@ -266,3 +281,123 @@ func TestClaudeRemoteCallerNamingNoFolderIsToldToolsAreElsewhere(t *testing.T) {
 		}
 	}
 }
+
+// workDirsBody makes a subscription request whose system prompt is system
+// and whose turns are the {role, content} pairs said.
+func workDirsBody(system string, said ...[2]string) func(string) string {
+	return func(string) string {
+		ms := make([]map[string]string, len(said))
+		for i, s := range said {
+			ms[i] = map[string]string{"role": s[0], "content": s[1]}
+		}
+		b, _ := json.Marshal(map[string]any{"model": "claude-sonnet-5", "max_tokens": 100, "system": system, "messages": ms})
+		return string(b)
+	}
+}
+
+// The run works in the folder the caller itself works in, not in one a
+// message merely quotes. The caller says its folder in its instructions
+// (--bare's "CWD:" line, Claude Code's " - Primary working directory:")
+// or in a system message of its own (Claude Code 2.1.296 and later), and
+// a user turn is no caller's word: a line it quotes — alone on its line,
+// inside a longer one, or naming a folder not here — leaves the run where
+// the caller runs. A caller that names its folder in a turn still has it
+// honored (Codex's <environment_context>, OpenCode's <env>), and a
+// "Primary working directory: /y (was /x)" notice is read as /y (#4449).
+func TestClaudeRunsWhereTheCallerRunsNotWhereATurnQuotes(t *testing.T) {
+	for _, c := range []struct {
+		name string
+		body func(proj, other string) func(string) string
+	}{
+		{"bare CWD", func(proj, _ string) func(string) string {
+			return workDirsBody("CWD: " + proj)
+		}},
+		{"bare CWD with instructions", func(proj, _ string) func(string) string {
+			return workDirsBody("CWD: " + proj + "\nYou are a coding agent.\n - Primary working directory: " + proj)
+		}},
+		{"a turn quotes a line alone", func(proj, other string) func(string) string {
+			return workDirsBody(" - Primary working directory: "+proj, [2]string{"user", "Primary working directory: " + other})
+		}},
+		{"a turn quotes a line mid-line", func(proj, other string) func(string) string {
+			return workDirsBody(" - Primary working directory: "+proj, [2]string{"user", `A note I copied from a log: "Primary working directory: ` + other + `". Ignore it.`})
+		}},
+		{"a turn quotes a folder not here", func(proj, _ string) func(string) string {
+			return workDirsBody(" - Primary working directory: "+proj, [2]string{"user", "Primary working directory: /no/such/folder/here"})
+		}},
+		{"Codex says its folder in a turn", func(proj, _ string) func(string) string {
+			return workDirsBody("You are a coding agent.", [2]string{"user", "<environment_context>\n  <cwd>" + proj + "</cwd>\n  <shell>zsh</shell>\n</environment_context>"})
+		}},
+		{"OpenCode says its folder in a turn", func(proj, _ string) func(string) string {
+			return workDirsBody("You are a coding agent.", [2]string{"user", "<env>\n  Working directory: " + proj + "\n</env>"})
+		}},
+		{"Claude Code's environment message", func(proj, other string) func(string) string {
+			return workDirsBody("You are a coding agent.", [2]string{"system", " - Primary working directory: " + proj}, [2]string{"user", "Primary working directory: " + other})
+		}},
+		{"the folder was another", func(proj, other string) func(string) string {
+			return workDirsBody("Primary working directory: " + proj + " (was " + other + ")")
+		}},
+	} {
+		t.Run(c.name, func(t *testing.T) {
+			var proj, other string
+			dirs, work, _, _, told := claudeWorkDirsBody(t, "", nil, func(home string) string {
+				proj = filepath.Join(home, "proj")
+				other = filepath.Join(home, "other")
+				if err := os.MkdirAll(proj, 0o755); err != nil {
+					t.Fatal(err)
+				}
+				if err := os.MkdirAll(other, 0o755); err != nil {
+					t.Fatal(err)
+				}
+				return c.body(proj, other)(home)
+			})
+			proj = evalSymlinks(proj)
+			if len(dirs) != 2 || dirs[0] != proj || dirs[1] != proj {
+				t.Fatalf("working directories %q, want the caller's %s (shared %s)", dirs, proj, work)
+			}
+			if strings.Contains(told, "every tool runs in") {
+				t.Fatalf("a run in the caller's own folder was told its environment is elsewhere: %s", told)
+			}
+		})
+	}
+}
+
+// A word of the caller's folder masked by the redact rules (a directory
+// named for the user, say) stands in the request as a placeholder, and a
+// placeholder names no folder on disk: the folder is unmasked before it
+// is looked for, so the run works in the caller's folder, not in magpie's
+// shared one (#4449).
+func TestClaudeRunsInTheFolderAMaskedPathNames(t *testing.T) {
+	const word = "someuser"
+	base := t.TempDir()
+	proj := filepath.Join(base, word+"-libs", "proj")
+	if err := os.MkdirAll(proj, 0o755); err != nil {
+		t.Fatal(err)
+	}
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	if err := settings.Save(settings.Settings{Redact: true, RedactWords: []string{word}}); err != nil {
+		t.Fatal(err)
+	}
+	t.Cleanup(func() { settings.Save(settings.Settings{}) })
+	t.Cleanup(gwmw.Mask(masking.Masker{}))
+	dirs, work, _, _, told := claudeWorkDirsBody(t, "", nil, func(string) string {
+		// the bridge reads the request as the gateway's masking left it:
+		// the caller sent the folder as it is, and the masker stood in for
+		// the word before the request reached the bridge
+		b := workDirsBody("You are a coding agent.\n - Primary working directory: "+proj, [2]string{"user", "list the files"})("")
+		_, masked, _, err := maskTextHits(context.Background(), b)
+		if err != nil {
+			t.Fatal(err)
+		}
+		if strings.Contains(masked, word) {
+			t.Fatalf("%s was not masked: %s", word, masked)
+		}
+		return masked
+	})
+	proj = evalSymlinks(proj)
+	if len(dirs) != 2 || dirs[0] != proj || dirs[1] != proj {
+		t.Fatalf("working directories %q, want the caller's %s (shared %s)", dirs, proj, work)
+	}
+	if strings.Contains(told, "every tool runs in") {
+		t.Fatalf("a run in the caller's own folder was told its environment is elsewhere: %s", told)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
