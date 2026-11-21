What's wrong
---

Thanks @Raters0 for the report and the process evidence: on macOS, the Agents row's Restart for WorkBuddy AI quit the app and never opened it again. The GUI really does quit — what's left behind is a detached sidecar under the bundle (`Contents/Resources/app.asar/main/sidecar-entry.js`, reparented to launchd, holding the IPC sockets a next start needs, with `codebuddy --serve` hanging off it), and the reopen waited for *every* process under `Contents/` to end. The wait ran out its whole 30s on that sidecar every time, and Restart came back "still open" without ever asking `open` to bring the app back.

Root cause
---

`reopenBundle` polled `pgrep` over `bundle + "/Contents/"` — every helper under the bundle, whatever outlives its GUI. The app's own process is the narrower thing the running check already counts, `Contents/MacOS/<exe>` (`findRestartable`), which the sidecar does not match; the reopen just never used it. (One note on the report: `findRestartable`'s narrow pattern does *not* match the sidecar, so magpie's "is it running" read is already right — only the reopen's wait was wide.)

The fix
---

The reopen waits for the bundle's own executable, read from its Info.plist as the running check does; helpers that outlive their GUI no longer hold it. A bundle whose plist yields no executable keeps the old whole-bundle wait. "Still open" keeps its meaning for a GUI that really stays (the existing test for that passes unchanged).

```diff
From 90d8baffa07fe01c107bfa11b0c47813ff7cbd97 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 11:20:11 +0800
Subject: [PATCH] agent restart: the reopen waits for the app's own process,
 not every helper under the bundle
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

On macOS, Restart for WorkBuddy AI quit the app and never opened it
again: the GUI really quits, but it leaves a detached sidecar running
under Contents/ (holding the IPC sockets for a next start, with the
codebuddy child hanging off it), and reopenBundle waited for every
process under the bundle to end — so it ran out the whole 30s wait on
the sidecar every time and returned "still open" before ever asking
`open` to bring the app back (#3700, with the reporter's process
evidence).

The reopen now waits for the process findRestartable counts alone, the
bundle's own executable at Contents/MacOS/<exe>, looked up from the
bundle's Info.plist as the running check already does. Helpers that
outlive their GUI — WorkBuddy AI's sidecar, and any other agent's — no
longer hold the reopen. An app whose executable can't be read from the
plist keeps the old whole-bundle wait.

Fixes #3700

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/apprestart.go              | 16 ++++++--
 internal/agent/apprestart_sidecar_test.go | 49 +++++++++++++++++++++++
 2 files changed, 61 insertions(+), 4 deletions(-)
 create mode 100644 internal/agent/apprestart_sidecar_test.go

diff --git a/internal/agent/apprestart.go b/internal/agent/apprestart.go
index 9a2f0653c..fdf7574c4 100644
--- a/internal/agent/apprestart.go
+++ b/internal/agent/apprestart.go
@@ -320,7 +320,7 @@ func (a *Agent) RestartApp(ctx context.Context) error {
 		return restartErr(noticeRestartCurrent, a)
 	}
 	if c.bundle != "" {
-		return reopenBundle(ctx, a, c.bundle)
+		return reopenBundle(ctx, a, c.bundle, r.mac)
 	}
 	return a.restartWin(ctx, r, c)
 }
@@ -417,13 +417,21 @@ func waitGone(ctx context.Context, r restartable, limit time.Duration) bool {
 	}
 }
 
-// reopenBundle quits the app at bundle, as ⌘Q does, waits for every
-// process under it to end and opens it again (codex_app.go's way).
-func reopenBundle(ctx context.Context, a *Agent, bundle string) error {
+// reopenBundle quits the app at bundle, as ⌘Q does, waits for the app's
+// own process to end and opens it again (codex_app.go's way). The app's
+// own process is the one findRestartable counts, Contents/MacOS/<exe>:
+// WorkBuddy AI leaves a detached sidecar under Contents/ behind when its
+// GUI quits — it holds the IPC sockets for a next start — and waiting for
+// every process under the bundle ran out the whole wait on it every time,
+// so the app was quit and never opened again (#3700).
+func reopenBundle(ctx context.Context, a *Agent, bundle string, mac desktopApp) error {
 	if err := appQuit(ctx, bundle); err != nil {
 		return restartErr(noticeRestartAsk, a)
 	}
 	pat := regexp.QuoteMeta(bundle + "/Contents/")
+	if exe := bundleExecutable(bundle, mac.id); exe != "" {
+		pat = "^" + regexp.QuoteMeta(filepath.Join(bundle, "Contents", "MacOS", exe)) + "( |$)"
+	}
 	end := time.Now().Add(appQuitWait)
 	for len(running(pat)) > 0 {
 		if time.Now().After(end) {
diff --git a/internal/agent/apprestart_sidecar_test.go b/internal/agent/apprestart_sidecar_test.go
new file mode 100644
index 000000000..d5cd88243
--- /dev/null
+++ b/internal/agent/apprestart_sidecar_test.go
@@ -0,0 +1,49 @@
+package agent
+
+import (
+	"context"
+	"path/filepath"
+	"regexp"
+	"slices"
+	"strings"
+	"testing"
+	"time"
+)
+
+// The reopen waits for the app's own process, not every helper under the
+// bundle: WorkBuddy AI leaves a detached sidecar running when its GUI
+// quits — it holds the IPC sockets for a next start — and waiting for it
+// ran out the whole wait every time, so Restart quit the app and never
+// opened it again (#3700).
+func TestReopenBundleWaitsForTheAppAlone(t *testing.T) {
+	home := restartSandbox(t)
+	apps := filepath.Join(home, "Applications")
+	bundle := macApp(t, apps, "WorkBuddy AI.app", "com.workbuddy.workbuddy-ai", "Electron")
+	restartOnMac = true
+	var pats []string
+	running = func(pat string) []runningProc {
+		pats = append(pats, pat)
+		// the GUI quit; the sidecar it left under the bundle keeps running
+		sidecar := bundle + "/Contents/Resources/app.asar/main/sidecar-entry.js --token x"
+		if regexp.MustCompile(pat).MatchString(sidecar) {
+			return []runningProc{{time.Hour, sidecar}}
+		}
+		return nil
+	}
+	a := workbuddyAI(home)
+	appQuit = func(_ context.Context, b string) error { return nil }
+	var opened []string
+	appOpen = func(_ context.Context, b string) error { opened = append(opened, b); return nil }
+	appQuitWait = 200 * time.Millisecond
+	if err := reopenBundle(context.Background(), a, bundle, workbuddyAIApp); err != nil {
+		t.Fatalf("a sidecar left behind held the reopen: %v (asked %q)", err, pats)
+	}
+	if len(opened) != 1 || opened[0] != bundle {
+		t.Fatalf("opened %q, want the app back once", opened)
+	}
+	if !slices.ContainsFunc(pats, func(p string) bool {
+		return strings.Contains(p, `WorkBuddy AI\.app/Contents/MacOS/Electron`)
+	}) {
+		t.Fatalf("not asked by the bundle's executable: %q", pats)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

git am applies it as is; SHA-256 first 16: `c869b37af31aab80`

Verification
---

| check | result |
| --- | --- |
| RED on the parent's code | `TestReopenBundleWaitsForTheAppAlone` failed before the fix: the wide pattern matched the sidecar on every poll (33 polls at the test's 200ms wait) and ended "still open" — the report's exact shape, on a stand-in bundle with the sidecar path from the report |
| GREEN | the same test ok: the reopen asks by `Contents/MacOS/Electron`, opens the app once, and the sidecar holds nothing |
| the old semantics keep | `TestWorkBuddyRestartOnMac` (incl. "an app that doesn't end: said, never opened again"), `TestWorkBuddyRestartOnWindows`, `TestRestartEndsAppInTrayAtOnce`, `TestRestartAppsOnWindows` all pass unchanged |
| ablation | reverting `internal/agent/apprestart.go` to the parent turns the build red (the test names the new parameter), so the red on record is the pre-fix run above |
| package full | `go test -tags nogui ./internal/agent/` ok (155s), re-run directed green after rebasing onto `e17b6cefc` (the base moved one Qoder commit; agent files untouched) |
| gofmt / vet | clean (`tr -d '\r'` judgement) |
| am gate | `git am -3` onto a clean tree at `e17b6cefc` applies as is |
| siblings | `rg` over the restart paths: `findRestartable` already counts the main process alone; Windows restart walks its own process tree (`restartWin`) and is untouched; Codex's app restart is separate (`codex_app.go`) and untouched |

Not verified
---

No real WorkBuddy AI install was driven here (the stand-in bundle and the report's own sidecar path stand in for it); the app re-adopting or replacing its sidecar on start is the reporter's observation, not re-run from here.

AI use: the patch and its test were written with AI assistance; I've read the whole diff and the tests pass.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (ggbdpq) or add Co-authored-by: ggbdpq ggbdpq@gmail.com.

Branch with the commit: fix/3700-reopen-app-alone (head 90d8baffa07f96d01bd44d2c25850e9be0c12d14)
