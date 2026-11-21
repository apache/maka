Following the analysis above, the direction I said I'd be happy to verify with tests: the fixable face is the port held behind the wedged exit, so the patch takes the first mitigation — free the port before the final exit — and leaves your watchdog as the separate design call it is.

**What's wrong**: on the restart's quit path nothing stops the gateway this process serves. `stopServing` (`internal/gui/backend.go`) has one caller, in `make dev`; a production restart goes `restartInto` → `leave(h.app.Quit)` → the Wails quit → `runtime.exit`, with the listener's close left to the process dying. In both dumps the gateway's `Accept` and `Serve` goroutines are still parked on that listener while goroutine 1 throws: the port lives exactly as long as the process does, so an exit that wedges keeps `:3425` bound and unanswered until the process is killed by hand, and the new build can only log "is taken but doesn't answer as magpie yet" and wait. (Diagnosis of the wedge itself, per the dumps and unchanged: `runtime.main → exit(ExitProcess)` re-entered by a callback, throwing in `exitsyscall` — nothing magpie-side can catch that; the parked `WaitForSingleObject` of goroutine 17647 is the updater's own benign `cmd.Wait`.)

**The fix**: `leave` (`internal/gui/handover.go`) — the one chokepoint every restart-quit goes through (update install ×2, the tray's Restart, Settings' AutoRestart, the data-folder move) — now takes the gateway off the port first and waits for that, at most `restartStopWait` (30s): the `servedRun.stop`/`done` seam `stopServedLocked` (the gateway pause) already uses. Past the wait the quit runs anyway, cutting what is in flight as the exit would have — a restart is only asked for once the gateway is idle (#577), so the wait covers the gateway's own end of a stray late request, and the degradation is said in the log rather than silent. The Mac's and Linux's handover defers through `pending` and already releases the socket explicitly (`endBackend` + `serving.Wait`); it is untouched. With this, even a wedged exit costs the new build only its `AwaitPredecessor` window (~20s) — it gives up waiting for the old pid, finds the port free, and serves — instead of "until killed".

**Verification** (base `d2a80b317`):

| check | result |
|---|---|
| Red without the fix (new tests kept, `handover.go` reverted to `quit()` only) | `TestRestartQuitTakesTheGatewayOffThePort`: `the quit ran with the gateway still served here` (real gateway via `serveGatewayLocked`, quit runs, port still answers); `TestRestartQuitRunsPastAGatewayThatWontEnd`: `the quit ran before the gateway was asked to stop: "quit" first` |
| With the fix | both green; with `-race` green |
| Ablation | removing the single `stopServingForRestart()` call in `leave` (1-deletion diff) → both red → restored → green |
| Package | `go test -tags nogui ./internal/gui`: green except `TestProxyCheckSaysAProxyPassedBy` and `TestSessionReadsRoutes`, which fail the same way on the parent commit `d2a80b317` (full run; `TestSessionReadsRoutes` passes in isolation there, so it is run-order sensitive, not from this patch) |
| other | `go vet -tags nogui ./internal/gui` clean, gofmt clean, `GOOS=windows go build ./internal/gui` clean; `GOOS=linux` blocked by the known wails beta.24 `undefined: pointer` pre-existing |
| `git am` | applies clean on `d2a80b317` |

**Siblings**: `rg "leave\(" internal/gui` → 5 call sites, all restarts, all covered by the one chokepoint. Left alone, why: `stopServedLocked` (gateway pause) — right seam, but its wait is unbounded and a pause isn't quitting; `AskQuit` (plain quit) — no successor waits on the port there; `quitMagpieOnPort` (quitting an older copy at the port) — bounded by its own 30s ctx and reports `Stuck` when it can't; `restartGateway` (Gateway page button) — in-process stop, not a process exit; `handover.run` — the handover path already releases the socket explicitly before quitting.

**When the read fails**: `stopServingForRestart` with `served` nil or `servedRun.stop` unwired returns at once — a process that serves nothing on the port has nothing to release, and quits as before.

**Not verified**: a real Windows handover (the wedge and the fix's effect on it), and which callback fires — the dumps are the live evidence for the shape; the wedge itself is below any Go code's reach, which is why the fix makes its harm (the port held) impossible rather than curing it. Your watchdog (kill the `.old*` pid after N seconds from the new instance) would compose with this for hangs before the marker; left as your design call.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gui: a restart's quit takes the gateway off the port before it goes (#5922) — git am applies it as is; SHA-256 first 16: 64b6d629b8539be2</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 11 Nov 2026 05:21:58 +0800
Subject: [PATCH] gui: a restart's quit takes the gateway off the port before
 it goes (#5922)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

The old app of an update on Windows could hang on its way out: inside
ExitProcess a callback re-entered the Go runtime and threw in
exitsyscall, and the process neither died nor answered — with the
gateway's Accept and Serve goroutines still parked on the listener it
never closed. :3425 stayed bound and unanswered until the process was
killed by hand, and the new build could only log that the port was
taken and wait.

Nothing on the restart's quit path stopped the gateway: the port went
with the process, so a quit that never ends held it forever. Now leave
(that is, every restart that quits because a new version is starting)
takes the gateway it served off the port first and waits for that, at
most restartStopWait; past it the quit runs anyway, cutting what is in
flight as the exit would have. A restart is only asked for once the
gateway is idle (#577), so the wait covers the gateway's own end of a
stray late request. The Mac's and Linux's handover already hands the
socket over explicitly and is not touched.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gui/handover.go      | 35 ++++++++++++-
 internal/gui/handover_test.go | 96 +++++++++++++++++++++++++++++++++++
 2 files changed, 130 insertions(+), 1 deletion(-)

diff --git a/internal/gui/handover.go b/internal/gui/handover.go
index 87184b78a..553984616 100644
--- a/internal/gui/handover.go
+++ b/internal/gui/handover.go
@@ -145,15 +145,48 @@ func (ho *handover) failed(err error) {
 	(<-ho.quit)()
 }
 
-// leave quits once a handover under way is done, else at once.
+// leave quits once a handover under way is done, else takes the gateway
+// this one served off the port and quits.
 func leave(quit func()) {
 	if ho := pending.Load(); ho != nil {
 		ho.quit <- quit
 		return
 	}
+	stopServingForRestart()
 	quit()
 }
 
+// restartStopWait bounds how long a restart's quit waits for the gateway
+// it served to be off the port. A var for tests.
+var restartStopWait = 30 * time.Second
+
+// stopServingForRestart takes the gateway this process serves off the
+// port before a restart's quit (#5922): the port lives exactly as long
+// as the process does, and the old app of an update on Windows whose
+// exit wedged — hung inside ExitProcess, a callback re-entering the
+// runtime while the gateway's Accept and Serve goroutines were still
+// parked — kept :3425 bound and unanswered until it was killed by hand,
+// the new build only able to say the port was taken and wait. A restart
+// is only asked for once the gateway is idle (#577), so what the wait
+// leaves to the gateway's own end is the cut of a stray late request;
+// past restartStopWait the caller quits anyway, cutting it as the exit
+// would have, rather than trade the wedge for a hang of its own.
+func stopServingForRestart() {
+	gatewayMu.Lock()
+	defer gatewayMu.Unlock()
+	gw := served.Load()
+	if gw == nil || servedRun.stop == nil {
+		return // this one serves nothing on the port
+	}
+	servedRun.stop()
+	select {
+	case <-servedRun.done:
+		served.CompareAndSwap(gw, nil)
+	case <-time.After(restartStopWait):
+		log.Printf("update: the gateway still ending after %s; quitting with it cut", restartStopWait)
+	}
+}
+
 // run hands the gateway over and quits: once the new magpie serves on its
 // socket and this one has finished its requests, or, should it not take
 // it in time, as a restart did before (the new one opened once this one
diff --git a/internal/gui/handover_test.go b/internal/gui/handover_test.go
index 19241164b..aecc11630 100644
--- a/internal/gui/handover_test.go
+++ b/internal/gui/handover_test.go
@@ -1,6 +1,8 @@
 package gui
 
 import (
+	"path/filepath"
+	"strconv"
 	"testing"
 	"time"
 
@@ -61,3 +63,97 @@ func TestHandsOverOnlyWhereItCan(t *testing.T) {
 		t.Fatal("began a handover it can't make")
 	}
 }
+
+// restartSandbox gives a test a home, a gateway port of its own and no
+// handover under way, so leave takes the plain restart's path.
+func restartSandbox(t *testing.T) int {
+	t.Helper()
+	h := t.TempDir()
+	t.Setenv("HOME", h)
+	t.Setenv("USERPROFILE", h)
+	t.Setenv("APPDATA", filepath.Join(h, "AppData"))
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(h, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(h, ".cache"))
+	port := freePort(t)
+	t.Setenv("MAGPIE_ADDR", "127.0.0.1:"+strconv.Itoa(port))
+	wasPending := pending.Load()
+	pending.Store(nil)
+	wasServed := served.Load()
+	served.Store(nil)
+	t.Cleanup(func() {
+		gatewayMu.Lock()
+		stopServedLocked()
+		gatewayMu.Unlock()
+		served.Store(wasServed)
+		pending.Store(wasPending)
+	})
+	return port
+}
+
+// A restart that can't hand the gateway over quits to let the version it
+// started serve in its place, and its quit takes the gateway off the port
+// first (#5922): the port lives exactly as long as the process does, and
+// the old app of an update on Windows whose exit wedged — hung inside
+// ExitProcess with the gateway's Accept and Serve goroutines still
+// parked — kept :3425 bound and unanswered until it was killed by hand.
+// Here the gateway is served and answered on for real, and the quit only
+// runs once the port is free.
+func TestRestartQuitTakesTheGatewayOffThePort(t *testing.T) {
+	port := restartSandbox(t)
+	gatewayMu.Lock()
+	gw := serveGatewayLocked()
+	gatewayMu.Unlock()
+	if gw == nil {
+		t.Fatal("the gateway didn't start")
+	}
+	quits := make(chan struct{}, 1)
+	leave(func() { quits <- struct{}{} })
+	select {
+	case <-quits:
+	case <-time.After(10 * time.Second):
+		t.Fatal("the restart's quit never ran")
+	}
+	if served.Load() != nil {
+		t.Fatal("the quit ran with the gateway still served here")
+	}
+	for deadline := time.Now().Add(5 * time.Second); answers(port); time.Sleep(50 * time.Millisecond) {
+		if time.Now().After(deadline) {
+			t.Fatal("the gateway is still answered on after the quit ran")
+		}
+	}
+}
+
+// And a gateway that won't end doesn't hold the quit: the stop is asked
+// for first, and past restartStopWait the quit runs anyway, cutting what
+// is in flight as the exit would have cut it.
+func TestRestartQuitRunsPastAGatewayThatWontEnd(t *testing.T) {
+	restartSandbox(t)
+	events := make(chan string, 2)
+	oldWait := restartStopWait
+	restartStopWait = 250 * time.Millisecond
+	t.Cleanup(func() { restartStopWait = oldWait })
+	gatewayMu.Lock()
+	oldStop, oldDone := servedRun.stop, servedRun.done
+	t.Cleanup(func() {
+		gatewayMu.Lock()
+		servedRun.stop, servedRun.done = oldStop, oldDone
+		gatewayMu.Unlock()
+	})
+	served.Store(gateway.New()) // never started: nothing ends it
+	servedRun.stop = func() { events <- "stop" }
+	servedRun.done = make(chan struct{}) // never closed
+	gatewayMu.Unlock()
+	quits := make(chan struct{}, 1)
+	leave(func() { events <- "quit"; quits <- struct{}{} })
+	select {
+	case <-quits:
+	case <-time.After(10 * time.Second):
+		t.Fatal("the restart's quit never ran past a gateway that won't end")
+	}
+	if got := <-events; got != "stop" {
+		t.Fatalf("the quit ran before the gateway was asked to stop: %q first", got)
+	}
+	if got := <-events; got != "quit" {
+		t.Fatalf("the gateway's stop came twice: %q again", got)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

Branch: [hunt-n6-5922-handover-hang](https://github.com/ggbdpq/magpie/tree/hunt-n6-5922-handover-hang) (`ce79dc9dad84e630803c2f8790e1f9458e3c4220`).

</details>
