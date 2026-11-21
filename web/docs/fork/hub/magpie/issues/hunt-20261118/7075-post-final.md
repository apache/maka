The reported split: `magpie provider models codex +<model>` updated `/v1/models` at once while `~/.codex/magpie-desktop-models.json` — the list the Codex app's picker reads — stayed behind for tens of minutes, and only a GUI action brought them back together.

**Root cause:** the desk list's rebuild needs the ChatGPT backend's list, which is asked in the background and kept per process. The first sync that finds it unknown starts the ask and leaves the file as it was — unknown, never an empty list — and the ask's result asks for a sync round of its own. A GUI action triggers both rounds inside the long-running app, so the file follows there; a CLI command is a short-lived process that exited after the first round, before the ask answered and its round ran. `magpie visible codex all` is the same: it clears `hiddenModels` as #4587 fixed, and its sync leaves the file to an ask that outlives the process.

**The fix:** `run` waits the ask out and the sync round the ask's result asked for before it ends (`gateway.CodexDesktopAskSettled`, bounded by the ask's own `codexDeskWait`; a command with no ask under way waits nothing). The CLI writes the rebuilt file itself, so the disk follows `/v1/models` whether or not magpie's app is running. The gateway's native route keeps the background ask — a Codex request must not wait up to 30s on a cold cache — and the unknown-leaves-the-file-as-it-was semantic is unchanged everywhere. When the backend cannot be asked, the rebuild still happens from Codex's own `models_cache.json` where it has entries, as `CodexDesktopCatalog` already falls back.

**Red without the fix:** `TestCodexDesktopAskSettledWaitsForTheAsk` (new) holds the waiter while a gated fetch runs and goes only when it answers, the change is told once for the round it owes, and a settled ask is not waited on again. With the wait stubbed to none and the test kept, it fails at `the ask was waited out while the fetch was still running`; restored, green.

**Siblings:** `run` is the only short-lived exit that owes the desk rebuild; the gateway's native route keeps its background ask, and the app process already converges on its own triggers. `deskList`'s own semantics (a hand edit, another tool, a user's own `model_catalog_json`) are untouched. The report's other three faces are left for your call: clearing `hiddenModels.<agent>` when a provider layer exposes the model would override records the user set (magpie's defaults never cover user-set values), so the safe forms are telling the user "exposed, but hidden for `<agent>`" at expose time, distinguishing "provider not exposed / hidden for the agent / shown" in `magpie models <agent>`, and a single-model `magpie visible <agent> +<model>` — the first two are display changes, the third new command surface.

| Check | Result |
| --- | --- |
| `TestCodexDesktopAskSettledWaitsForTheAsk` | Green at final head: holds while the fetch runs, goes when it answers, change told once, settled ask not waited on |
| Ablation (wait stubbed to none, test kept) | `the ask was waited out while the fetch was still running`; restored, green |
| Desk rebuild on a known list | Existing `TestCodexDesktopListBesideSignIn` / `TestCodexDesktopListNamedAt` cover the second-round rebuild unchanged |
| Targeted `-race` (`TestCodexDesktop` family) | Pass |
| `go test -tags nogui -timeout=45m -count=1 ./internal/gateway/` | Exit 1 with `TestOpenCodeGoOwnFreeModelGetsNothingOfOpenCodes` alone (911.6s), run in the documented isolated environment (external Go 1.26.8 toolchain, PATH without the real Claude installation, process-local scutil): the darwin-assertion failure upstream 35e5989f1 introduced — the same test fails on bare base `2ab2f6913`. A first pair of package runs on the plain PATH showed 73 Claude-bridge failures that this isolated rerun collapses to the one: the host's own Claude installation reaching test shims, the environment family the #6914 verification describes. |
| `go test -tags nogui -timeout=45m -count=1 ./internal/cli/` | Exit 1 with the three #6223 isolation failures alone (`TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr`, `TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr`, `TestUpdateFindsAMagpieThatWroteNoRecord`, 57.7s) — the same three tests the isolated full-suite runs report. |
| `gofmt -l` changed files, `git diff --check` | No output / clean |
| `go vet ./…`; `GOOS=linux go vet -tags nogui ./…`; `GOOS=windows go vet ./…` | All exit 0 |
| darwin/windows `go build ./…`; linux `go build -tags nogui ./…` | All exit 0 |
| Strict `git am` on base `2ab2f6913` | Applies cleanly; resulting tree equals final head; author remains `ggbdpq <ggbdpq@gmail.com>` |

**Not verified:** the reporter's macOS 26 desktop end-to-end — the app-reader detection cannot be faked in a CLI-package test, so the command-exit path is verified by the gateway-level test above plus the agent-level rebuild tests, and the wiring is two calls of those tested primitives; the 30s worst case when the backend hangs (the ask then fails and the round still runs, rebuilding from Codex's own cache where it has entries); the report's faces 1, 3 and 4 (left above).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/7075-cli-waits-desk-rebuild](https://github.com/ggbdpq/magpie/tree/fix/7075-cli-waits-desk-rebuild), head `e63ca2610b34ad33443389c5cf6568cc8d76ca0e`.

<details><summary>patch: cli: a command ends with the Codex app's list rebuilt after the ask (#7075) — git am applies it as is; SHA-256 first 16: 40919efbc08b9702</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 19 Nov 2026 01:21:06 +0800
Subject: [PATCH] cli: a command ends with the Codex app's list rebuilt after
 the ask (#7075)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: the first sync that finds the backend's list unknown
starts its ask and leaves the Codex app's file as it was — unknown,
never an empty one. The ask's result asked for a sync round of its own,
but a short-lived command exited before it: a model exposed with
`magpie provider models codex +<model>` updated /v1/models at once
while ~/.codex/magpie-desktop-models.json stayed behind for tens of
minutes, and Codex's picker read the stale list (#7075). run now waits
the ask out and the round it owes before it ends. The wait is bounded
by the ask's own codexDeskWait, and a command with no ask under way
waits nothing.

Run: TestCodexDesktopAskSettledWaitsForTheAsk (new) — the waiter holds
while the fetch runs, goes when it answers, the change is told once,
and a settled ask is not waited on again. See the issue post for the
matrix.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/main.go                   |  7 +++-
 internal/gateway/codex_desktop.go      | 21 +++++++++++
 internal/gateway/codex_desktop_test.go | 52 ++++++++++++++++++++++++++
 3 files changed, 79 insertions(+), 1 deletion(-)

diff --git a/internal/cli/main.go b/internal/cli/main.go
index 845d23cd2..afe753a03 100644
--- a/internal/cli/main.go
+++ b/internal/cli/main.go
@@ -345,9 +345,14 @@ func servesPages(args []string) bool {
 func run(args []string) error {
 	// a command that saved a provider or a group ends with the agents'
 	// files written, which its save no longer waits for; and a test's run
-	// leaves catalog.Changed as it found it
+	// leaves catalog.Changed as it found it. A change to what is exposed
+	// or shown also owes the Codex app's list, whose rebuild rides the
+	// backend ask the first sync started (#7075): the ask is waited out,
+	// then the round its result asked for.
 	was := catalog.Changed
 	defer func() {
+		agent.SyncCatalogSettled()
+		gateway.CodexDesktopAskSettled()
 		agent.SyncCatalogSettled()
 		catalog.Changed = was
 	}()
diff --git a/internal/gateway/codex_desktop.go b/internal/gateway/codex_desktop.go
index 1af4934e6..646c865b9 100644
--- a/internal/gateway/codex_desktop.go
+++ b/internal/gateway/codex_desktop.go
@@ -113,6 +113,27 @@ func codexDeskAsk(who string, due bool) {
 	}
 }
 
+// CodexDesktopAskSettled waits for the backend list ask under way, if one
+// is. The desk list's rebuild rides the sync round the ask's result asks
+// for, and a short-lived command that changed what is exposed or shown
+// ends only after that round is written — not after the one that left the
+// file as it was while the ask ran (#7075: the CLI's
+// magpie-desktop-models.json stayed behind /v1/models for tens of
+// minutes). An ask bounds itself at codexDeskWait; none under way returns
+// at once.
+func CodexDesktopAskSettled() {
+	codexDesk.Lock()
+	done := codexDesk.done
+	codexDesk.Unlock()
+	if done == nil {
+		return
+	}
+	select {
+	case <-done:
+	case <-time.After(codexDeskWait):
+	}
+}
+
 // codexDeskInputs reads, outside codexDesk's lock, what codexDeskDue weighs.
 func codexDeskInputs() (behind func(string) bool, listed []string, listedAt time.Time) {
 	now := codexDeskVersion()
diff --git a/internal/gateway/codex_desktop_test.go b/internal/gateway/codex_desktop_test.go
index 2ddda1674..5879bd8ce 100644
--- a/internal/gateway/codex_desktop_test.go
+++ b/internal/gateway/codex_desktop_test.go
@@ -461,3 +461,55 @@ func TestKeepCodexDeskFreshAsksWhenDue(t *testing.T) {
 		t.Fatalf("the loop's ask: %v\n%s", ok, b)
 	}
 }
+
+// A command that changes what is exposed or shown ends with the desk
+// list's rebuild written: the first sync leaves the file as it was while
+// the backend's ask runs (unknown, never an empty list), and the ask's
+// result asks for a sync round of its own. CodexDesktopAskSettled waits
+// that ask, so a short-lived command waits it and the round it owes
+// before it exits (#7075: the CLI's magpie-desktop-models.json stayed
+// behind /v1/models for tens of minutes).
+func TestCodexDesktopAskSettledWaitsForTheAsk(t *testing.T) {
+	codexSignedIn(t)
+	codexDeskReset(t)
+	release := make(chan struct{})
+	was := codexDeskFetch
+	codexDeskFetch = func(ctx context.Context) ([]byte, error) {
+		<-release
+		return []byte(`{"models":[{"slug":"gpt-5.5","priority":1,"visibility":"list"}]}`), nil
+	}
+	t.Cleanup(func() { codexDeskFetch = was })
+	var told atomic.Int64
+	CodexDesktopChanged = func() { told.Add(1) }
+
+	// the first look starts the ask and knows no list yet
+	if _, ok := CodexDesktopCatalog(); ok {
+		t.Fatal("the backend's list is known before it answered")
+	}
+	// a caller that waits the ask out is still waiting while it runs
+	settled := make(chan struct{})
+	go func() { CodexDesktopAskSettled(); close(settled) }()
+	select {
+	case <-settled:
+		t.Fatal("the ask was waited out while the fetch was still running")
+	case <-time.After(100 * time.Millisecond):
+	}
+	// the ask answers: the waiter goes, the round the result asks for is
+	// told, and the list is known from then on
+	close(release)
+	<-settled
+	if n := told.Load(); n != 1 {
+		t.Fatalf("the ask's result told the change %d times, want 1", n)
+	}
+	if b, ok := CodexDesktopCatalog(); !ok || !strings.Contains(string(b), "gpt-5.5") {
+		t.Fatalf("the ask's list: %q %v", b, ok)
+	}
+	// a wait with no ask under way goes at once
+	waited := make(chan struct{})
+	go func() { CodexDesktopAskSettled(); close(waited) }()
+	select {
+	case <-waited:
+	case <-time.After(2 * time.Second):
+		t.Fatal("a settled ask was waited on again")
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
