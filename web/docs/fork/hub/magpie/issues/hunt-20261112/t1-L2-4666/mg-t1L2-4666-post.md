The race your report names is real and the diagnosis is exact — `SetOptions` and its four siblings (`Add`, `Remove`, `SetOff`, `Prefer`) read `Load()` and write `save()` whole under `listMu`, which is one process alone; the atomic replace (`steady.WriteFile`) keeps a half-written file from being read, and does nothing to serialize two whole-list read-change-writes from two magpies. The branch you built is a review candidate for a page-bridge CAS protocol, which is a host-API design question you rightly leave open — this patch is the smaller face underneath it, shaped like the locks magpie's own files already change under.

**What changed** (`internal/plugin/store.go`, one commit): every change to `plugins.json` — the GUI's Plugins page, a plugin page's options bridge, `magpie plugin options/prefer/remove`, migrate and backup all funnel into the five mutators — is now made under the file's lock (`plugins.json.lock`, `filelock.Mutex`, the shape of the accounts' `loginsMu` and mcp-signins' `fileMu`): lock, read the file afresh, change, write, unlock. So the gateway that runs all day and a magpie run from a terminal make their changes one at a time, and the one waiting reads what the other wrote: both stand. Reads stay unlocked (a stale list on screen, never a lost edit). A lock held longer than `filelock.Wait` (10s) goes on without, and a file system with no locks likewise — as before there was one.

This does not presuppose #5914's patch (still in review): it uses upstream's `internal/filelock` only, stands alone on current main, and touches nothing `providers.json`-side. And it is not a substitute for your protocol — a conditional page bridge would take this same lock and add the version compare on top; that layer is the design call your report asks about.

**Red without the change** (base `873b4987e`): with `store.go` back at the parent and the new tests kept, both fail on the behavior, deterministically:

```
--- FAIL: TestPluginOptionsKeepWhatAnotherMagpieSetMeanwhile
    store_lock_test.go:31: SetOptions went on while another magpie held plugins.json's lock (err <nil>)
--- FAIL: TestPluginPreferKeepsWhatAnotherMagpieSetMeanwhile
    store_lock_test.go:79: Prefer went on while another magpie held plugins.json's lock (err <nil>)
```

The test holds `plugins.json.lock` the way another process would, starts `SetOptions` (or `Prefer`) in a goroutine, saves the other magpie's change while it waits, then lets go: the change made after the lock's release sees the other's write, and both end up in the file. Restored, both green, `-race` green.

| Check | Result |
| --- | --- |
| the two new tests, before / after | red on the lines above / `ok` (and `ok -race`) |
| `go test ./internal/plugin -count=1 -timeout 25m` | ok except `TestHostToldTheGatewayAddress` — red on the parent commit `873b4987e` too (same `told MAGPIE_ADDR=127.0.0.1:3591`; a port-migration flake this machine's proxy already gives), so no new red from this change |
| `gofmt -l internal/plugin` | clean |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | ok; ok; ok |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | ok; ok; ok |
| `git am` replay on a clean `873b4987e` checkout | applies; replayed tree byte-identical to the branch head |

**Siblings**: `rg` every `save(` of the store — the five mutators, all wrapped. Readers (`Written`, `tools.go`, the pages' lists) stay unlocked: worst case a stale view, no lost edit. `plugin-auth.json` was already locked (`lockAuth`, which `host.js` takes too); the plugin runtime's `plugins.yml` already holds a `filelock.Mutex` upstream; direct edits to `plugins.json` by hand take no lock — the same boundary every member of this family has. Agents' own settings files (Claude, Codex, Grok) are other writers of other files, out of this face.

**When the read fails**: `plugins.json` unreadable still falls to `lastgood`'s last good generation (#1505 semantics, untouched); a lock file that can't be opened has `filelock` go on without it, as it logs — the change is then exactly what it was before this patch.

**Not verified**: two real magpies on one `plugins.json` across machines — the cross-process hold here is the same OS lock taken from the test process, as in the family's fixtures; a real Windows terminal-vs-app run.

**Branch with the commit:** [`hunt-20261112-t1-4666`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-4666) (head `9345a92df451fb47`).

**Patch:** <details><summary>patch: plugin: a plugins.json change one magpie makes keeps what another saved meanwhile (#4666) — git am applies it as is; SHA-256 first 16: e04902cbd80e38d3</summary>

````text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 12 Nov 2026 22:04:04 +0800
Subject: [PATCH] plugin: a plugins.json change one magpie makes keeps what
 another saved meanwhile (#4666)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: every change to plugins.json (Add, Remove, SetOff, Prefer,
SetOptions — the GUI's Plugins page, a plugin page's options bridge,
`magpie plugin options/prefer/remove`, migrate and backup) is now made
under the file's lock, plugins.json.lock, the same shape the accounts'
logins and mcp-signins.json are changed under: listMu is this process
alone, so the gateway and a magpie run from a terminal read, changed and
wrote whole lists past each other, and the later write went out with
what the other had saved since its read. Under the file lock every
change reads the file afresh, so both stand. A lock held longer than
filelock.Wait goes on without it, as before there was one; a file
system with no locks likewise. Reads are unlocked, as they were.

Run (darwin/arm64, GOCACHE pinned, upstream/main 873b4987e + this):
- go test ./internal/plugin -run 'TestPluginOptionsKeepWhatAnotherMagpieSetMeanwhile|TestPluginPreferKeepsWhatAnotherMagpieSetMeanwhile' -count=1 -race: ok
  (each red before the fix: "SetOptions went on while another magpie
  held plugins.json's lock" / "Prefer went on …", deterministic)
- go test ./internal/plugin -count=1 -timeout 25m: ok except TestHostToldTheGatewayAddress
  (a port-migration flake this machine's proxy already gave: red on the
  parent commit 873b4987e too, same "told MAGPIE_ADDR=127.0.0.1:3591")
- gofmt -l internal/plugin: clean; go vet ./...: ok;
  GOOS=linux go vet -tags nogui ./... and GOOS=windows go vet ./...: ok
- go build, GOOS=linux go build -tags nogui, GOOS=windows go build: ok

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/plugin/store.go           |  23 ++++++
 internal/plugin/store_lock_test.go | 112 +++++++++++++++++++++++++++++
 2 files changed, 135 insertions(+)
 create mode 100644 internal/plugin/store_lock_test.go

diff --git a/internal/plugin/store.go b/internal/plugin/store.go
index 52999776e..b0c422db0 100644
--- a/internal/plugin/store.go
+++ b/internal/plugin/store.go
@@ -34,6 +34,7 @@ import (
 	"time"
 
 	"github.com/yetone/magpie/internal/edit"
+	"github.com/yetone/magpie/internal/filelock"
 	"github.com/yetone/magpie/internal/filememo"
 	"github.com/yetone/magpie/internal/lastgood"
 	"github.com/yetone/magpie/internal/lazyre"
@@ -73,6 +74,17 @@ type List struct {
 
 var listMu sync.Mutex
 
+// listFileMu is held through every read a change is made from and its
+// write of plugins.json (the mutators below): the gateway that runs all
+// day and a magpie run from a terminal (`magpie plugin options …`, the
+// plugin manager) are separate processes, and listMu never saw the other
+// one, so the later whole-list write went out with what the other had
+// saved since its read (#4666). Under it every change reads the file
+// afresh, so both changes stand. A lock another magpie holds is waited
+// for up to filelock.Wait, then gone on without, as before there was
+// one; the same shape as mcpauth's fileMu.
+var listFileMu = filelock.Mutex{Path: func() string { return listPath() + ".lock" }}
+
 // bunMu is held through each bun command that changes plugins/ (add,
 // update, remove). Two at once read package.json and bun.lock before
 // either writes them, so one's change is lost (#2002, anganing: after an
@@ -461,8 +473,10 @@ func add(ctx context.Context, spec, version string) (Entry, error) {
 	if err := ensurePi(ctx, Target(spec)); err != nil {
 		return Entry{}, err
 	}
+	listFileMu.Lock()
 	listMu.Lock()
 	defer listMu.Unlock()
+	defer listFileMu.Unlock()
 	l := Load()
 	e := Entry{Spec: spec}
 	name := Name(spec)
@@ -606,11 +620,13 @@ func indexOf(l List, name string) int {
 
 // Remove takes a plugin off the list (and out of plugins/).
 func Remove(ctx context.Context, name string) error {
+	listFileMu.Lock()
 	listMu.Lock()
 	l := Load()
 	i := indexOf(l, name)
 	if i < 0 {
 		listMu.Unlock()
+		listFileMu.Unlock()
 		return fmt.Errorf("no plugin %q", name)
 	}
 	e := l.Plugins[i]
@@ -618,6 +634,7 @@ func Remove(ctx context.Context, name string) error {
 	maps.DeleteFunc(l.Prefer, func(_, s string) bool { return s == e.Spec })
 	err := save(l)
 	listMu.Unlock()
+	listFileMu.Unlock()
 	if err != nil {
 		return err
 	}
@@ -632,8 +649,10 @@ func Remove(ctx context.Context, name string) error {
 
 // SetOff turns a plugin off or back on.
 func SetOff(name string, off bool) error {
+	listFileMu.Lock()
 	listMu.Lock()
 	defer listMu.Unlock()
+	defer listFileMu.Unlock()
 	l := Load()
 	i := indexOf(l, name)
 	if i < 0 {
@@ -653,8 +672,10 @@ func SetOff(name string, off bool) error {
 // with it; one switched off leaves the id to the others until it is on
 // again.
 func Prefer(name, id string) error {
+	listFileMu.Lock()
 	listMu.Lock()
 	defer listMu.Unlock()
+	defer listFileMu.Unlock()
 	l := Load()
 	i := indexOf(l, name)
 	if i < 0 {
@@ -677,8 +698,10 @@ func Prefer(name, id string) error {
 // SetOptions sets the options a plugin is handed (a middleware's
 // ctx.options); nil takes them away.
 func SetOptions(name string, opts map[string]any) error {
+	listFileMu.Lock()
 	listMu.Lock()
 	defer listMu.Unlock()
+	defer listFileMu.Unlock()
 	l := Load()
 	i := indexOf(l, name)
 	if i < 0 {
diff --git a/internal/plugin/store_lock_test.go b/internal/plugin/store_lock_test.go
new file mode 100644
index 000000000..f98b2168d
--- /dev/null
+++ b/internal/plugin/store_lock_test.go
@@ -0,0 +1,112 @@
+package plugin
+
+import (
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/filelock"
+)
+
+// Two magpies — the gateway that runs all day, and one run from a
+// terminal (`magpie plugin options …`, the plugin manager) — write
+// plugins.json from separate processes, and the in-process listMu never
+// saw the other one (#4666): the later whole-list write went out with
+// what the other had saved since its read. A change is now made under
+// the file's lock, so the one waiting reads what the other wrote before
+// it goes on, and both changes stand.
+
+func TestPluginOptionsKeepWhatAnotherMagpieSetMeanwhile(t *testing.T) {
+	storeSandbox(t)
+	writeList(t, `{"plugins":[{"spec":"p-a"},{"spec":"p-b","options":{"x":1}}]}`)
+	unlock, held := filelock.Lock(listPath()+".lock", filelock.Wait)
+	if !held {
+		t.Skip("this file system holds no locks")
+	}
+	defer unlock()
+	done := make(chan error, 1)
+	go func() { done <- SetOptions("p-a", map[string]any{"ours": true}) }()
+	time.Sleep(300 * time.Millisecond)
+	select {
+	case err := <-done:
+		t.Fatalf("SetOptions went on while another magpie held plugins.json's lock (err %v)", err)
+	default:
+	}
+	// the other magpie's save lands meanwhile: its own options for p-b
+	other := Load()
+	for i := range other.Plugins {
+		if other.Plugins[i].Spec == "p-b" {
+			other.Plugins[i].Options = map[string]any{"theirs": float64(1)}
+		}
+	}
+	if err := save(other); err != nil {
+		t.Fatal(err)
+	}
+	unlock()
+	if err := <-done; err != nil {
+		t.Fatal(err)
+	}
+	l := Load()
+	var a, b *Entry
+	for i := range l.Plugins {
+		switch l.Plugins[i].Spec {
+		case "p-a":
+			a = &l.Plugins[i]
+		case "p-b":
+			b = &l.Plugins[i]
+		}
+	}
+	if a == nil || a.Options["ours"] != true {
+		t.Errorf("p-a's options = %v, want ours kept", a)
+	}
+	if b == nil || b.Options["theirs"] != float64(1) {
+		t.Errorf("p-b's options = %v, want what the other magpie saved kept", b)
+	}
+}
+
+func TestPluginPreferKeepsWhatAnotherMagpieSetMeanwhile(t *testing.T) {
+	storeSandbox(t)
+	writeList(t, `{"plugins":[{"spec":"p-a"},{"spec":"p-b"}]}`)
+	unlock, held := filelock.Lock(listPath()+".lock", filelock.Wait)
+	if !held {
+		t.Skip("this file system holds no locks")
+	}
+	defer unlock()
+	done := make(chan error, 1)
+	go func() { done <- Prefer("p-a", "prov") }()
+	time.Sleep(300 * time.Millisecond)
+	select {
+	case err := <-done:
+		t.Fatalf("Prefer went on while another magpie held plugins.json's lock (err %v)", err)
+	default:
+	}
+	// the other magpie's save lands meanwhile: p-b turned off
+	other := Load()
+	for i := range other.Plugins {
+		if other.Plugins[i].Spec == "p-b" {
+			other.Plugins[i].Off = true
+		}
+	}
+	if err := save(other); err != nil {
+		t.Fatal(err)
+	}
+	unlock()
+	if err := <-done; err != nil {
+		t.Fatal(err)
+	}
+	l := Load()
+	var a, b *Entry
+	for i := range l.Plugins {
+		switch l.Plugins[i].Spec {
+		case "p-a":
+			a = &l.Plugins[i]
+		case "p-b":
+			b = &l.Plugins[i]
+		}
+	}
+	if a == nil || l.Prefer["prov"] != "p-a" {
+		t.Errorf("prefer = %v, want p-a kept", l.Prefer)
+	}
+	if b == nil || !b.Off {
+		t.Errorf("p-b off = %v, want what the other magpie saved kept", b)
+	}
+}
-- 
2.50.1 (Apple Git-155)
````

</details>

Attribution: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
