Patch as `git am`, attached below. Branch and checksum in the footer.

## Summary

After an update is put in, magpie now restarts its own installed service (the launchd agent / systemd unit `magpie daemon install` writes) when that service is running — so the gateway goes on from the new version, instead of a process left executing a file that is no longer on disk. This is suggestion 1 of this issue, wired at every place an update is installed: `magpie update` in a terminal, the app's restart into an update (Settings' AutoRestart, the panel's button, and its answer to `magpie update`'s ask), and the app's quit-time install.

## Root cause (as @Reign9201 diagnosed; the code matches)

`update.Install` renames the running bundle aside into the staging folder, puts the new one in its place, then removes the staging folder — the renamed-aside old bundle included. A `magpie serve` left running goes on with the binary whose file was just unlinked. macOS can no longer verify that vnode's signature and treats the process as unauthorized: its TCC refuses Desktop, Documents and Downloads (the issue's reproduction matrix pins exactly those three); the `claude` provider spawns the real CLI in the request's cwd, the child inherits the same responsible identity, can't read its own directory and exits 1 — said back as 502. `internal/daemon`'s `Restart` exists for exactly this (its comment: "a magpie updated in place serves as the new version"), and `magpie daemon restart` was indeed the cure — but nothing in any update path called it.

## The fix

- `daemon.RestartReplaced()` — restarts the installed service when it is installed and running. One not running, or no service of magpie's kind at all (Windows, Android): no error, no restart — it starts as the new version the next time the system starts it.
- `magpie update` (internal/cli/update_cli.go): after the bundle swap and after `ReplaceBinary`, restarts the service and says "the magpie service restarts into X now". When it did, the ask to the magpie serving the gateway (`/v1/magpie/restart`) is skipped — the service answers for itself; with nothing restarted, the ask goes out as before, so an app-only setup reads exactly as it did.
- The app's restart into an update (internal/gui/update.go `restartInto` — the funnel for AutoRestart, the panel's button, and the reply to `magpie update`): restarts the service only when this app's own install swapped the files in. An update `magpie update` put in is that command's, which restarted the service already. magpie web (`magpie web`, `magpie serve --web`) is skipped: it reexecs itself in its own place — as the service, when it is one.
- The app's quit-time install (internal/gui/app.go `OnShutdown`): same guard.

The restart cuts what the service has in flight, exactly as the manual `magpie daemon restart` this issue reports as the cure does. Handing the gateway over without cutting would take a serve-side handover design (the existing one is app-to-app); not attempted here.

## Verification

| Check | Result |
| --- | --- |
| `TestRestartReplaced` (internal/daemon; faked `launchctl`/`systemctl`, darwin + linux + a windows `goos`) | green: a running service is restarted (last call `launchctl kickstart -k …`, resp. `systemctl --user restart magpie.service`); one not running or not installed is left alone and runs nothing; a failed restart comes back as the error |
| `TestUpdateRestartsTheService` (internal/cli) | green: the line said when the service restarted, `""` with none running, a failure said in so many words |
| `TestUpdateRestartsTheService` (internal/gui) | green: a swap this app makes restarts the service once; another magpie's update doesn't restart it here; the web reexec doesn't either |
| Ablation | the four product files reverted to d8b3749ef (upstream/main tip): all three tests fail (the new names don't exist there); files restored: green |
| Packages | `go test ./internal/daemon/...` ok; `./internal/cli/...` ok except the known pre-existing `TestEveryRouteHasACommandOrIsNamed`; `./internal/gui/...` ok except the known pre-existing `TestProxyCheckSaysAProxyPassedBy` — both unrelated to this patch (a route-naming parity check and a proxy-env check) |
| race | `go test -race ./internal/daemon/` full, `-race` on the cli and gui update tests: clean |
| gofmt / vet / build | `gofmt -l` on the touched files: none; `go vet` clean; `go build ./...` ok (darwin/arm64) |

## Notes

- The issue's last observation — `magpie daemon status` could name the file the running service executes, which would have made this state visible at a glance — is left out of this patch to keep it to the restart.
- When the service was restarted, the command no longer asks the gateway to restart (`/v1/magpie/restart`), since the service answers for itself; the app's own restart (when one is running) is unaffected and still hands its gateway over as before.

## Attribution

Patch written by an AI (GLM-5.3-Flash via ZCode); author ggbdpq.

<details>
<summary>Patch (git am) — SHA-256 (first 16): f82cf163586ae341</summary>

```diff
From 3ecb0f976eda488ad5b7baa15a29bacd8553b5a1 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 06:40:03 +0800
Subject: [PATCH] update: the service an update left running a deleted binary
 is restarted (#4335)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

An update swaps the new magpie in where the file the running one came
from was, and on the Mac `Install` then deletes the old bundle. A
`magpie serve` left running (the service `magpie daemon install` writes)
goes on with a binary whose file is gone, which macOS can't vouch for:
its TCC refuses Desktop, Documents and Downloads, and every CLI the
gateway starts in them (claude, codex) exits 1, said back as 502.
`magpie daemon restart` was the cure — daemon.Restart exists for
exactly "a magpie updated in place serves as the new version" — but
nothing in the update flow called it.

Now an update restarts the installed service when it is running, at
each place an update is put in: `magpie update` in a terminal, and the
app's restart into an update (AutoRestart, the panel's button) and its
quit-time install. magpie web, which reexecs itself in its own place,
as the service when it is one, is not the one to restart it; an update
another magpie put in (`magpie update`, whose ask the app answers)
isn't restarted from the app either. The restart cuts what the service
has in flight, as the manual `magpie daemon restart` does; the ask to
the magpie serving the gateway is skipped when the service was
restarted, since it answers for itself.

daemon.RestartReplaced says whether there was a running service to
restart. One not running, or not installed (Windows and Android have no
service of magpie's kind), is no error and no restart; it starts as the
new version the next time the system starts it.

Fixes #4335

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/update_cli.go              | 33 ++++++++++-
 internal/cli/update_restart_cli_test.go | 25 +++++++++
 internal/daemon/daemon.go               | 17 ++++++
 internal/daemon/daemon_test.go          | 75 +++++++++++++++++++++++++
 internal/gui/app.go                     |  8 +++
 internal/gui/update.go                  | 29 ++++++++++
 internal/gui/update_test.go             | 70 +++++++++++++++++++++++
 7 files changed, 255 insertions(+), 2 deletions(-)

diff --git a/internal/cli/update_cli.go b/internal/cli/update_cli.go
index 0a72d9e6a..aae06aedf 100644
--- a/internal/cli/update_cli.go
+++ b/internal/cli/update_cli.go
@@ -11,6 +11,7 @@ import (
 	"strings"
 	"time"
 
+	"github.com/yetone/magpie/internal/daemon"
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/settings"
 	"github.com/yetone/magpie/internal/update"
@@ -26,6 +27,26 @@ var (
 	updatePackagedBy  = update.PackagedBy
 )
 
+// serviceRestart is daemon.RestartReplaced; tests stand in for it.
+var serviceRestart = daemon.RestartReplaced
+
+// restartService is what magpie update says of magpie's own service
+// (`magpie daemon install`) after putting an update in: the service runs
+// magpie from the very binary the update replaced — on the Mac one whose
+// file the swap has deleted, which macOS holds against the process
+// (#4335) — so it is restarted into the new one. "" with none running,
+// which the ask to the magpie serving the gateway follows.
+var restartService = func(version string) string {
+	restarted, err := serviceRestart()
+	if err != nil {
+		return "the magpie service couldn't be restarted: " + err.Error()
+	}
+	if restarted {
+		return "the magpie service restarts into " + version + " now"
+	}
+	return ""
+}
+
 // updateEveries are the intervals magpie update auto takes, by their
 // minutes in settings.UpdateEveries.
 var updateEveries = map[string]int{"30m": 30, "1h": 60, "6h": 360, "24h": 1440}
@@ -233,7 +254,11 @@ func updateCmd(args []string) error {
 			return err
 		}
 		fmt.Println(green.Render("✓"), "updated", tilde(app), "to", rel.Version)
-		fmt.Println(muted.Render("  " + restartRunning(gateway.URL(), rel.Version)))
+		if said := restartService(rel.Version); said != "" {
+			fmt.Println(muted.Render("  " + said))
+		} else {
+			fmt.Println(muted.Render("  " + restartRunning(gateway.URL(), rel.Version)))
+		}
 		if stale := update.StaleCLI(rel.Version); stale != "" {
 			// The copy won't follow the app; the fix is the link install.sh
 			// makes. `magpie update` run from the copy can't do it (it
@@ -261,7 +286,11 @@ func updateCmd(args []string) error {
 		return err
 	}
 	fmt.Println(green.Render("✓"), "updated to", rel.Version)
-	fmt.Println(muted.Render("  " + restartRunning(gateway.URL(), rel.Version)))
+	if said := restartService(rel.Version); said != "" {
+		fmt.Println(muted.Render("  " + said))
+	} else {
+		fmt.Println(muted.Render("  " + restartRunning(gateway.URL(), rel.Version)))
+	}
 	return nil
 }
 
diff --git a/internal/cli/update_restart_cli_test.go b/internal/cli/update_restart_cli_test.go
index d0e168247..47f0bdad2 100644
--- a/internal/cli/update_restart_cli_test.go
+++ b/internal/cli/update_restart_cli_test.go
@@ -2,6 +2,7 @@ package cli
 
 import (
 	"encoding/json"
+	"errors"
 	"io"
 	"net/http"
 	"net/http/httptest"
@@ -54,3 +55,27 @@ func TestUpdateAsksTheRunningMagpieToRestart(t *testing.T) {
 		t.Errorf("none running: %q", got)
 	}
 }
+
+// magpie update restarts magpie's own service when it was running the
+// binary the update replaced (on the Mac one whose file the swap has
+// deleted), and says so; the ask to the magpie serving the gateway is
+// skipped then, and made as before when there was nothing to restart.
+func TestUpdateRestartsTheService(t *testing.T) {
+	was := serviceRestart
+	defer func() { serviceRestart = was }()
+	// running: restarted, said
+	serviceRestart = func() (bool, error) { return true, nil }
+	if got := restartService("0.2.0"); got != "the magpie service restarts into 0.2.0 now" {
+		t.Errorf("a running service: %q", got)
+	}
+	// not running, not installed: nothing said, the ask follows
+	serviceRestart = func() (bool, error) { return false, nil }
+	if got := restartService("0.2.0"); got != "" {
+		t.Errorf("none running: %q", got)
+	}
+	// a restart that failed is said, and the ask follows it
+	serviceRestart = func() (bool, error) { return true, errors.New("no such process") }
+	if got := restartService("0.2.0"); got != "the magpie service couldn't be restarted: no such process" {
+		t.Errorf("a failed restart: %q", got)
+	}
+}
diff --git a/internal/daemon/daemon.go b/internal/daemon/daemon.go
index c83a6f9f8..69dbc782e 100644
--- a/internal/daemon/daemon.go
+++ b/internal/daemon/daemon.go
@@ -266,6 +266,23 @@ func Stop() error { return installed(manager.stop) }
 // as the new version.
 func Restart() error { return installed(manager.restart) }
 
+// RestartReplaced restarts the installed service when it is running: an
+// update has put a new magpie where the file the running one came from
+// was (on the Mac the swap deletes the old bundle, and a process left
+// running its binary runs a file that is no longer there, which macOS
+// holds against it — its TCC refuses Desktop, Documents and Downloads,
+// and every program it starts with them, #4335), and Restart has it
+// serve the new one. One that isn't running starts as the new one the
+// next time the system starts it. Says whether it restarted; nothing to
+// restart is no error.
+func RestartReplaced() (bool, error) {
+	st, err := Get()
+	if err != nil || !st.Installed || !st.Running {
+		return false, nil
+	}
+	return true, Restart()
+}
+
 // Get is what the system says of the service.
 func Get() (Status, error) {
 	m, err := current()
diff --git a/internal/daemon/daemon_test.go b/internal/daemon/daemon_test.go
index 79f1a637e..b008a824e 100644
--- a/internal/daemon/daemon_test.go
+++ b/internal/daemon/daemon_test.go
@@ -316,6 +316,81 @@ func TestLaunchdInstall(t *testing.T) {
 	}
 }
 
+// An update puts a new magpie where the file the service's process runs
+// from was (on the Mac the swap deletes the old bundle), and a service
+// left running goes on with the old one, one the Mac can't vouch for:
+// it is restarted into the new one; a service that isn't installed or
+// isn't running is left alone, to start as the new one the next time the
+// system starts it (#4335).
+func TestRestartReplaced(t *testing.T) {
+	for _, os_ := range []string{"linux", "darwin"} {
+		t.Run(os_, func(t *testing.T) {
+			log, dir := fakes(t, os_)
+			// none installed: nothing to restart, nothing run
+			if restarted, err := RestartReplaced(); restarted || err != nil {
+				t.Errorf("none installed: %v, %v", restarted, err)
+			}
+			if c := calls(t, log); c[0] != "" {
+				t.Errorf("none installed ran %v", c)
+			}
+			if err := Install(Options{}); err != nil {
+				t.Fatal(err)
+			}
+			idle, up := "ActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=enabled\nExecMainStatus=0\n",
+				"ActiveState=active\nSubState=running\nMainPID=4242\nUnitFileState=enabled\nExecMainStatus=0\n"
+			idleFile, upFile := filepath.Join(dir, "systemctl.show.out"), filepath.Join(dir, "systemctl.show.out")
+			restart, fail := "systemctl --user restart magpie.service", filepath.Join(dir, "systemctl.restart.fail")
+			if os_ == "darwin" {
+				idle, up = "gui/501/com.yetone.magpie.serve = {\n\tstate = not running\n}\n",
+					"gui/501/com.yetone.magpie.serve = {\n\tstate = running\n\tpid = 777\n}\n"
+				idleFile, upFile = filepath.Join(dir, "launchctl.print.out"), filepath.Join(dir, "launchctl.print.out")
+				uid := strconv.Itoa(os.Getuid())
+				restart = "launchctl kickstart -k gui/" + uid + "/com.yetone.magpie.serve"
+				fail = filepath.Join(dir, "launchctl.kickstart.fail")
+			}
+			// installed, not running: left alone
+			write(t, idleFile, idle)
+			os.Remove(log)
+			if restarted, err := RestartReplaced(); restarted || err != nil {
+				t.Errorf("not running: %v, %v", restarted, err)
+			}
+			for _, c := range calls(t, log) {
+				if strings.Contains(c, "restart") || strings.Contains(c, "kickstart") {
+					t.Errorf("a service not running had %q run", c)
+				}
+			}
+			// installed and running: restarted
+			write(t, upFile, up)
+			os.Remove(log)
+			restarted, err := RestartReplaced()
+			if err != nil || !restarted {
+				t.Errorf("running: %v, %v", restarted, err)
+			}
+			got := calls(t, log)
+			if len(got) == 0 || got[len(got)-1] != restart {
+				t.Errorf("a running service was restarted with %v, want %q", got, restart)
+			}
+			// a restart that fails is the caller's to say
+			write(t, fail, "no such process")
+			t.Cleanup(func() { os.Remove(fail) })
+			if _, err := RestartReplaced(); err == nil || !strings.Contains(err.Error(), "no such process") {
+				t.Errorf("a failed restart: %v", err)
+			}
+		})
+	}
+	// no service of magpie's kind here (Windows, Android): nothing to
+	// restart, and no error
+	t.Run("windows", func(t *testing.T) {
+		fakes(t, "linux")
+		prev := goos
+		t.Cleanup(func() { goos = prev })
+		goos = "windows"
+		if restarted, err := RestartReplaced(); restarted || err != nil {
+			t.Errorf("windows: %v, %v", restarted, err)
+		}
+	})
+}
+
 // Windows and Android have no service of this kind: the error points to
 // what they have.
 func TestUnsupported(t *testing.T) {
diff --git a/internal/gui/app.go b/internal/gui/app.go
index dbb12d377..1418502a0 100644
--- a/internal/gui/app.go
+++ b/internal/gui/app.go
@@ -452,7 +452,15 @@ func Run(version string, showMain bool, link string) error {
 			// Codex's own, for the threads no Codex has open: with magpie
 			// gone they still go on (LukeMa on X)
 			agent.PortCodexRollouts(3 * time.Second)
+			// the service runs magpie from the binary this swap replaced,
+			// if this one made one (an update another magpie put in is
+			// that one's to restart the service for): restarted, it
+			// serves the new one (#4335)
+			swapped := !updates.replaced()
 			updates.install(false)
+			if swapped {
+				restartTheService()
+			}
 		},
 		// Wails exits on some webview errors; say why before it does.
 		ErrorHandler: func(err error) { log.Println("magpie:", err) },
diff --git a/internal/gui/update.go b/internal/gui/update.go
index 19666944b..d1f18b3a3 100644
--- a/internal/gui/update.go
+++ b/internal/gui/update.go
@@ -13,6 +13,7 @@ import (
 	"sync"
 	"time"
 
+	"github.com/yetone/magpie/internal/daemon"
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/settings"
 	"github.com/yetone/magpie/internal/update"
@@ -784,6 +785,23 @@ func updateRoutes(mux *http.ServeMux, w Windows) {
 // relaunchBinary is update.RelaunchBinary; tests stand in for it.
 var relaunchBinary = update.RelaunchBinary
 
+// restartReplaced is daemon.RestartReplaced; tests stand in for it.
+var restartReplaced = daemon.RestartReplaced
+
+// restartTheService has magpie's own service (`magpie daemon install`)
+// serve the update just put in: it runs magpie from the very binary the
+// swap replaced, and on the Mac the swap deletes the file it runs, a
+// process left running which macOS can't vouch for (its TCC refuses
+// Desktop, Documents and Downloads — #4335). Restarted, it serves the
+// new one; not running, it starts as the new one the next time the
+// system starts it. A failure is logged; the restart into the update
+// itself went through.
+func restartTheService() {
+	if _, err := restartReplaced(); err != nil {
+		log.Println("update:", err)
+	}
+}
+
 // restartFrom is restartToUpdate asked from w's page, on view: a browser
 // on the app's page restarts the app, with its window up as it was, not
 // opened on the tab the browser was on.
@@ -818,10 +836,21 @@ func restartInto(web, window bool, view string, bySelf bool) bool {
 		version = updates.latest.Version
 	}
 	updates.mu.Unlock()
+	// an update another magpie put in (`magpie update`, in a terminal)
+	// isn't this one's to act on: that command restarted the service for
+	// what it put in
+	swapped := !updates.replaced()
 	if !updates.install(true) {
 		return false
 	}
 	updatedInApp(version) // its first start leaves the notes to Settings (#525)
+	// the service runs magpie from the binary this swap replaced:
+	// restarted, it serves the new one (#4335). Not the web's to do,
+	// which reexecs itself in its own place, as the service when it is
+	// one.
+	if swapped && !web {
+		restartTheService()
+	}
 	if bySelf && !web {
 		markQuietRestart() // it comes back without taking focus
 	} else {
diff --git a/internal/gui/update_test.go b/internal/gui/update_test.go
index ea973f764..2226430aa 100644
--- a/internal/gui/update_test.go
+++ b/internal/gui/update_test.go
@@ -7,6 +7,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"os"
+	"path/filepath"
 	"sync/atomic"
 	"testing"
 	"time"
@@ -71,3 +72,72 @@ func TestUpdateStagedGivesWayToNewer(t *testing.T) {
 		t.Fatalf("%+v, %d downloads", j, downloads.Load())
 	}
 }
+
+// The service (`magpie daemon install`) runs magpie from the very binary
+// an update replaces: a restart into the update restarts the service
+// into the new one (#4335). An update another magpie put in (`magpie
+// update`, in a terminal) isn't this one's to act on, that command
+// having restarted the service already; and magpie web reexecs itself in
+// its own place, as the service when it is one.
+func TestUpdateRestartsTheService(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	exe := filepath.Join(t.TempDir(), "magpie")
+	os.WriteFile(exe, []byte("running magpie"), 0o755)
+
+	var restarts atomic.Int32
+	wasRestart := restartReplaced
+	restartReplaced = func() (bool, error) { restarts.Add(1); return true, nil }
+	defer func() { restartReplaced = wasRestart }()
+	var relaunched atomic.Bool
+	wasRelaunch := relaunchBinary
+	relaunchBinary = func(string, string, bool, string) error {
+		relaunched.Store(true)
+		return nil
+	}
+	defer func() { relaunchBinary = wasRelaunch }()
+
+	u := &updater{exe: exe, latest: &update.Release{Version: "0.1.11"}}
+	u.self, _ = os.Stat(exe)
+	u.staged = exe + ".new"
+	os.WriteFile(u.staged, []byte("new magpie"), 0o755)
+	defer os.Remove(u.staged)
+	o := updates
+	updates = u
+	defer func() { updates = o }()
+
+	// a swap this one makes: the service restarted with it
+	if !restartToUpdate(false, true, "") {
+		t.Fatal("restart to update failed")
+	}
+	if !relaunched.Load() {
+		t.Fatal("the new version never opened")
+	}
+	if restarts.Load() != 1 {
+		t.Fatalf("the service was restarted %d times", restarts.Load())
+	}
+
+	// an update another magpie put in: the service is not restarted here
+	os.WriteFile(exe, []byte("another magpie's update, in already"), 0o755)
+	u.staged, u.state = "", "ready"
+	if !restartInto(false, true, "", true) {
+		t.Fatal("a restart beside another magpie's update failed")
+	}
+	if restarts.Load() != 1 {
+		t.Fatalf("the service was restarted %d times for another magpie's update", restarts.Load())
+	}
+
+	// the web reexecs itself in its own place, as the service when it is
+	// one: no restart of it from here either
+	os.WriteFile(exe, []byte("running magpie"), 0o755)
+	u.self, _ = os.Stat(exe)
+	u.staged, u.state = exe+".new", "ready"
+	os.WriteFile(u.staged, []byte("new magpie"), 0o755)
+	wasReexec := webReexec.Load()
+	defer webReexec.Store(wasReexec)
+	if !restartInto(true, false, "", true) {
+		t.Fatal("a web restart to update failed")
+	}
+	if restarts.Load() != 1 {
+		t.Fatalf("the service was restarted %d times beside the web's own reexec", restarts.Load())
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/4335-daemon-tcc (head 3ecb0f976eda488ad5b7baa15a29bacd8553b5a1)
