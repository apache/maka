On the Library → RTK page, turning the Claude switch off failed for me exactly as reported in #2879's steps: the error saying the hook is still in Claude came up (zh UI: the hook is still inside Claude, EN backend string: "rtk's hook is still in Claude"), the hook stayed, and the row stayed on. Found the drift and a fix; patch below.

**The drift.** magpie decides Claude Code has RTK by searching `~/.claude/settings.json` whole for the string `"rtk hook claude"`, but its remover only looked under one key:

```go
// internal/library/rtk.go, before
dropHook(filepath.Join(d, "settings.json"), "hooks.PreToolUse", "rtk hook claude")
```

rtk 1.0.1's installer (its `src/hooks/init/claude.rs`) writes that same command under `hooks.PostToolUse` too, whenever the user's rtk pipeline has after_tool rules ("enabling `rtk:posthook` adds PostToolUse"), and rtk's own uninstaller (`remove_hook_from_json`) sweeps three events alike:

```rust
for event_key in [PRE_TOOL_USE_KEY, POST_TOOL_USE_KEY, SESSION_START_KEY] { // PreToolUse, PostToolUse, SessionStart
```

So with an RTK entry under `PostToolUse` (or the `SessionStart` entries rtk's uninstaller also knows), switching off in magpie removed only the `PreToolUse` entry, the whole-file check still found `"rtk hook claude"`, and `SetRTK` failed with `rtk's hook is still in Claude` — the hook stayed, the row stayed on, and the only way out was hand-editing `settings.json`. The fix makes the remover cover the same three events rtk itself writes and removes, still matching only RTK's own command and leaving the user's other hooks (and every other key) as they are.

Branch: [`hunt50-d-rtk-hook-off`](https://github.com/ggbdpq/magpie/tree/hunt50-d-rtk-hook-off), one commit on top of upstream `79160455`; the patch below applies with `git am`.

## What changed

- `internal/library/rtk.go`: Claude's `remove` now also calls `dropHook` for `hooks.PostToolUse` and `hooks.SessionStart` with the same `"rtk hook claude"` mark (so an absolute-path command like `/opt/homebrew/bin/rtk hook claude` is matched too, as before).
- `internal/library/rtk_test.go`: `TestRTKRemoveClaudeOtherEvents` models the file such an rtk leaves: RTK entries under all three events (one via its absolute-path form), the user's own `lint` hook under `PostToolUse` and `greet` under `SessionStart`, and `"model": "opus"`. Turning RTK off must remove exactly RTK's entries, keep the user's hooks and the model key, and leave the row reading off.
- The reporter's second ask (UI rollback of the switch when an off fails) is frontend and not touched here; with the removal in sync the reported failure itself goes away.

## Red before the fix

The new test on the base commit:

```
--- FAIL: TestRTKRemoveClaudeOtherEvents (2.32s)
    rtk_test.go:257: rtk's hook is still in Claude Code
```

That is the reported behavior. Ablation (fix reverted, test kept) reproduces it; restoring the fix turns it green.

## Verification

| Check | Command | Result |
|---|---|---|
| New test, base | `go test ./internal/library/ -run TestRTKRemoveClaudeOtherEvents` | FAIL: `rtk's hook is still in Claude Code` |
| New test, fixed | same | ok |
| Mutation: strict matcher (`==` instead of substring) | same | red (the absolute-path entry survives) |
| Mutation: remover drops every entry | same | red (the user's `lint`/`greet` hooks are taken out — the guards in the test) |
| Full owning package | `go test ./internal/library/` | ok 75.6s |
| gofmt | `gofmt -l internal/library/` | clean |
| go vet | darwin / linux / windows | clean |
| Build, owning package | `go build ./internal/library/` on darwin / linux / windows | ok |
| Full-repo build | `go build ./...` | darwin ok (pre-existing cgo warnings only); windows ok; linux fails inside the `wails/v3` module cache dependency (GTK/cgo environment, pre-existing, unrelated to this diff — `internal/library` itself builds on linux) |

## Siblings

The other RTK rows on the same page use the same `dropHook` remover; I checked each against rtk 1.0.1's own uninstaller (`src/hooks/init/{codex,gemini,cursor}.rs` at v1.0.1): Codex sweeps `PreToolUse` only, Gemini `BeforeTool` only, Cursor `preToolUse` (flat) only — each exactly the key magpie already drops, so they are in sync and unchanged. Claude was the only spec whose remover covered fewer events than rtk writes and its uninstaller removes. Copilot, OpenCode, Antigravity, Hermes, Pi and OMP remove whole files/folders, so there is nothing to drift.

## Not verified

- No real `rtk` binary was run here. The shapes rtk 1.0.1 writes are taken from rtk's own source at tag `v1.0.1` (`src/hooks/init/claude.rs`, `src/hooks/constants.rs`) and from the reporter's environment (rtk 1.0.1, macOS): `PreToolUse` always, `PostToolUse` when the pipeline has after_tool rules, and the `SessionStart` key rtk's own uninstaller also sweeps. Which of those the reporter's file held isn't known from the report; the fix covers all three, and the test models PostToolUse and SessionStart.
- Whether rtk 1.0.1's `SessionStart` entries ever carry the `rtk hook claude` command (vs the legacy `rtk-rewrite.sh` script, which `"rtk hook claude"` containment doesn't match) couldn't be pinned down from source alone; sweeping the key is what rtk's uninstaller does, and a miss there costs nothing.

**AI**: written with an AI coding agent; I've read the whole diff and can answer questions on it myself. The model name is in the commit's trailer.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch (0001-library-turning-RTK-off-matches-the-hook-Claude-s-se.patch)</summary>

```patch
From 49613be9b1fd3300d54267e5a12b264d6dfff469 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 07:59:40 +0800
Subject: [PATCH] library: turning RTK off matches the hook Claude's settings
 actually holds (#2879)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: taking RTK out of Claude Code now drops its hook entries
from hooks.PostToolUse and hooks.SessionStart in ~/.claude/settings.json
beside hooks.PreToolUse, matching the same "rtk hook claude" mark.

Why: magpie says Claude Code has RTK by searching the settings file
whole for "rtk hook claude", but its remover only looked under
hooks.PreToolUse. rtk 1.0.1's installer writes that command under
hooks.PostToolUse too, when the user's rtk pipeline has after_tool rules
(rtk:posthook; src/hooks/init/claude.rs), and rtk's own uninstaller
sweeps PreToolUse, PostToolUse and SessionStart alike. With an entry
under another event, switching RTK off in the Library removed the
PreToolUse entry, found the command still in the file, and failed with
"rtk's hook is still in Claude" — the reported bug: the row stayed on
and the hook had to be taken out by hand. The user's own hooks under
those events are kept, as the PreToolUse ones already were.

Run: go test ./internal/library/ (ok, 75.6s); the new
TestRTKRemoveClaudeOtherEvents fails on the base with "rtk's hook is
still in Claude Code" and passes with the fix; gofmt -l clean; go vet
clean on darwin, linux and windows; the package builds on all three.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/rtk.go      |  7 +++
 internal/library/rtk_test.go | 86 ++++++++++++++++++++++++++++++++++++
 2 files changed, 93 insertions(+)

diff --git a/internal/library/rtk.go b/internal/library/rtk.go
index 2dd47310..7684a4f8 100644
--- a/internal/library/rtk.go
+++ b/internal/library/rtk.go
@@ -94,8 +94,15 @@ var rtkSpecs = map[string]rtkSpec{
 		},
 		remove: func(*agent.Agent) error {
 			d := claudeDir()
+			// rtk writes its hook under PostToolUse too when its pipeline
+			// has after_tool rules (rtk 1.0.1, src/hooks/init/claude.rs),
+			// and its own uninstaller takes PreToolUse, PostToolUse and
+			// SessionStart out alike; has reads the file whole, so an entry
+			// left under another event kept the row on (#2879)
 			return errors.Join(
 				dropHook(filepath.Join(d, "settings.json"), "hooks.PreToolUse", "rtk hook claude"),
+				dropHook(filepath.Join(d, "settings.json"), "hooks.PostToolUse", "rtk hook claude"),
+				dropHook(filepath.Join(d, "settings.json"), "hooks.SessionStart", "rtk hook claude"),
 				dropLines(filepath.Join(d, "CLAUDE.md"), rtkRef),
 				rm(filepath.Join(d, "RTK.md")))
 		},
diff --git a/internal/library/rtk_test.go b/internal/library/rtk_test.go
index 663db26f..18b4c56f 100644
--- a/internal/library/rtk_test.go
+++ b/internal/library/rtk_test.go
@@ -210,6 +210,92 @@ func TestRTKRemove(t *testing.T) {
 	}
 }
 
+// TestRTKRemoveClaudeOtherEvents (#2879): rtk 1.0.1's installer writes its
+// hook under hooks.PostToolUse too, when the rtk pipeline has after_tool
+// rules (its src/hooks/init/claude.rs: "enabling rtk:posthook adds
+// PostToolUse"), and its uninstaller takes its entries out of PreToolUse,
+// PostToolUse and SessionStart alike. magpie says Claude Code has rtk by
+// the file whole, so an entry under another event kept the row on: turning
+// it off took only PreToolUse out, then said "rtk's hook is still in
+// Claude". The user's own hooks under those events stay.
+func TestRTKRemoveClaudeOtherEvents(t *testing.T) {
+	h := sandbox(t)
+	claude := filepath.Join(h, ".claude")
+	write(t, filepath.Join(claude, "settings.json"), `{
+  "model": "opus",
+  "hooks": {
+    "PreToolUse": [
+      {
+        "matcher": "Bash",
+        "hooks": [{"type": "command", "command": "rtk hook claude"}]
+      }
+    ],
+    "PostToolUse": [
+      {
+        "matcher": "Write",
+        "hooks": [{"type": "command", "command": "lint"}]
+      },
+      {
+        "matcher": "Bash",
+        "hooks": [{"type": "command", "command": "rtk hook claude"}]
+      }
+    ],
+    "SessionStart": [
+      {
+        "matcher": "startup",
+        "hooks": [{"type": "command", "command": " greet"}]
+      },
+      {
+        "matcher": "*",
+        "hooks": [{"type": "command", "command": "/opt/homebrew/bin/rtk hook claude"}]
+      }
+    ]
+  }
+}
+`)
+	if _, err := SetRTK("claude", false); err != nil {
+		t.Fatal(err)
+	}
+	var s struct {
+		Hooks map[string][]struct {
+			Matcher string `json:"matcher"`
+			Hooks   []struct {
+				Command string `json:"command"`
+			} `json:"hooks"`
+		} `json:"hooks"`
+		Model string `json:"model"`
+	}
+	if err := json.Unmarshal([]byte(read(t, filepath.Join(claude, "settings.json"))), &s); err != nil {
+		t.Fatal(err)
+	}
+	if s.Model != "opus" {
+		t.Errorf("model: %q", s.Model)
+	}
+	for event, entries := range s.Hooks {
+		for _, e := range entries {
+			for _, h := range e.Hooks {
+				if strings.Contains(h.Command, "rtk hook claude") {
+					t.Errorf("%s holds %q (matcher %q)", event, h.Command, e.Matcher)
+				}
+			}
+		}
+	}
+	if got := s.Hooks["PostToolUse"]; len(got) != 1 || got[0].Matcher != "Write" || len(got[0].Hooks) != 1 || got[0].Hooks[0].Command != "lint" {
+		t.Errorf("the user's PostToolUse hook didn't stay: %+v", got)
+	}
+	if got := s.Hooks["SessionStart"]; len(got) != 1 || got[0].Matcher != "startup" || len(got[0].Hooks) != 1 || got[0].Hooks[0].Command != " greet" {
+		t.Errorf("the user's SessionStart hook didn't stay: %+v", got)
+	}
+	if _, ok := s.Hooks["PreToolUse"]; ok {
+		t.Errorf("PreToolUse stayed: %+v", s.Hooks["PreToolUse"])
+	}
+	for _, a := range ReadRTK().Agents {
+		if a.ID == "claude" && a.On {
+			t.Error("claude still reads as on")
+		}
+	}
+}
+
 // openCodeRTK is an rtk on PATH that says it is version and, for
 // rtk init -g --opencode, writes the plugin that version writes: up to 0.51
 // one for OpenCode 1 only (hooks/opencode/rtk.ts at v0.51.0), from 0.52 one
-- 
2.50.1 (Apple Git-155)


```

</details>
