The overwrite this issue reports is fixed on main since the sync rework (#6428, 459d668b3): a part left out is marked in the sync state's `Off`, and one synced again joins like a first sync — each side's own counts as changed there, and the newer stays. @kupakupar's tested patch on their fork covered the same defect, with the baseline migration done in `Configure`; the rework took the rejoin path instead, so that branch was not applied. Thank you for the report and the repro — the regression test below follows your steps 1–4.

What the rework did not reach is **states written before it**. A magpie that synced with the library (or an agent's models) left out wrote that part's baseline as the nothing-hash and left no `Off` mark, because the field did not exist yet. On such a state — a computer upgraded in place that enables the part without a sync in between — re-enabling still classifies as "changed here" against a server already seen, and the older local content goes up over the server's newer one. That is reproducible on current main with a state from before the rework.

**Root cause**: `syncOnce` builds `rejoin` from `st.Off` alone (`internal/davsync/davsync.go`). A state with no `Off` mark skips it, the compare falls through to "changed here, server unchanged" (`lc && !rc`), and `take(local)` sends the older content up. `Configure` performs no migration either.

**The fix**: a part that syncs now, whose baseline is the nothing-hash a left-out part carries and that holds something of its own here, joins again the same way an `Off`-marked one does — each side's own counts as changed there, the newer stays. States since the rework already name such parts in `Off` and take the old path unchanged, and a first sync has no baseline to compare and is the join already. The part-level compare is where the behavior lives, so nothing else moves: no migration at load, none in `Configure`.

**Test**: `TestSyncPartTurnedBackOnWithoutOffMark` — b holds an older library text and syncs with the library off; a joins with a newer text; b's state has its `off` key stripped (a magpie from before `Off` was recorded); b enables the library and syncs. With the fix the server's newer library comes in and b's older text is replaced and kept aside (`Notice.Here: [library]`, the sync folder holds the replaced copy); without it the server ends up with b's older text.

| Check | Command | Result |
| --- | --- | --- |
| Red without the fix | base `a8fa771a6`, `internal/davsync/davsync.go` reverted, test kept | `--- FAIL: b's older library went up over the server's: Texts[default:older]` |
| With the fix | `go test ./internal/davsync -run TestSyncPartTurnedBackOn -count=1` | ok (the `Off`-marked and unmarked states both) |
| davsync package | `go test ./internal/davsync -count=1 -timeout 25m` | ok |
| Race, focused | `go test ./internal/davsync -race -run 'TestSyncPartTurnedBackOn|TestSyncOnlyLibrary|TestUndoSync' -count=1` | ok |
| gofmt / vet | `gofmt -l internal/davsync`; `go vet ./internal/davsync` | clean / clean |
| linux · windows · darwin | `GOOS=<os> go build -tags nogui ./...` | ok |
| git am replay | `format-patch -1 --zero-commit` applied onto `a8fa771a6` | tree `8d144288e21c2c73`, the head's tree |

**Siblings**: `rejoin` has three consumers — the two "nothing changed on either side" early returns and the per-part `again` flag — and the fallback only appends to it, so all three take the same path. `st.Off`'s only reader is the loop the fallback extends. `unset` and `changed` are untouched.

**When the read fails**: a part missing from the state's `Local` map reads as `""`, never as the nothing-hash, so the fallback does not fire; a state file that doesn't parse loads as no state, which is a first sync — the join itself.

One boundary, on purpose: a legacy state whose left-out part holds nothing here still waits for the server's part to change, or one more off/on toggle, before the server's content arrives — nothing is lost either way.

**Not verified**: an upgrade from a pre-rework release on real machines with real server content; the GUI sync form (Settings > Sync).

**Source**: reported in #3356, with the reporter's own tested analysis and fork patch (`b0ccf760`) as the starting point.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Branch with the commit: [hunt-20261114-d1-3356](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-3356) (head `17dff3cdcef8c29c`).

**Patch**: <details><summary>patch: davsync: a part re-enabled on a state with no Off mark joins again (#3356) — git am applies it as is; SHA-256 first 16: 301fbfd2f9e8108e</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 14 Nov 2026 08:18:38 +0800
Subject: [PATCH] davsync: a part re-enabled on a state with no Off mark joins
 again
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

kupakupar (#3356): re-enabling the library (or an agent's models) on a
computer that synced with the part left out sent that computer's older
content up over the server's newer one. What #6428 fixed for states
since it writes — a part left out is marked in Off, and one synced again
joins like a first sync — did not reach the states older magpies wrote:
they carry no Off mark, so the join saw a real hash against the
nothing-hash the last sync left and took it as a change here, against a
server it had already seen.

A part that syncs now, whose baseline is the nothing-hash a left-out
part carries and that holds something of its own here, joins again the
same way: each side's own counts as changed there, the newer stays. A
state since #6428 already names such parts in Off and takes the old
path; a first sync has no baseline to compare and is the join already.

Run (worktree at base a8fa771a6):
- go test ./internal/davsync -run TestSyncPartTurnedBackOn: ok, the
  marked and the unmarked state both; broken by hand: the unmarked
  state's fallback loop taken out puts the overwrite back
  (TestSyncPartTurnedBackOnWithoutOffMark)
- go test ./internal/davsync -count=1 -timeout 25m: ok
- gofmt -l: clean; go vet ./internal/davsync: clean

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/davsync/davsync.go         | 14 ++++
 internal/davsync/off_legacy_test.go | 99 +++++++++++++++++++++++++++++
 2 files changed, 113 insertions(+)
 create mode 100644 internal/davsync/off_legacy_test.go

diff --git a/internal/davsync/davsync.go b/internal/davsync/davsync.go
index 50b3e75ca..503d81c45 100644
--- a/internal/davsync/davsync.go
+++ b/internal/davsync/davsync.go
@@ -1344,6 +1344,20 @@ func syncOnce(ctx context.Context, c Config, st *state, pv *Plan) error {
 			rejoin = append(rejoin, p)
 		}
 	}
+	// a state written before Off was recorded (#3356): the last sync left
+	// a part out but wrote no mark of it, and all it left of the part here
+	// is the nothing-hash a left-out part carries. One that holds something
+	// of its own now joins like one turned back on, its older content never
+	// taken as a change here over the server's newer one.
+	nothing := hashes(backup.Bundle{})
+	for _, p := range Parts {
+		if !c.syncs(p) || slices.Contains(rejoin, p) || st.Local == nil {
+			continue
+		}
+		if st.Local[p] == nothing[p] && L[p] != st.Local[p] && !unset(local, p) {
+			rejoin = append(rejoin, p)
+		}
+	}
 	if unchanged {
 		if maps.Equal(L, st.Local) && !follow && !moved && len(rejoin) == 0 {
 			return nil // nothing changed on either side
diff --git a/internal/davsync/off_legacy_test.go b/internal/davsync/off_legacy_test.go
new file mode 100644
index 000000000..533ccf907
--- /dev/null
+++ b/internal/davsync/off_legacy_test.go
@@ -0,0 +1,99 @@
+package davsync
+
+import (
+	"encoding/json"
+	"io/fs"
+	"os"
+	"path/filepath"
+	"slices"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/library"
+	"github.com/yetone/magpie/internal/settings"
+)
+
+// dateLibrary puts the library's files at at: changed("library") reads
+// their times from the kernel's clock.
+func dateLibrary(t *testing.T, at time.Time) {
+	t.Helper()
+	os.Chtimes(filepath.Join(settings.Dir(), "library.json"), at, at)
+	os.Chtimes(library.Dir(), at, at)
+	filepath.WalkDir(library.Dir(), func(p string, d fs.DirEntry, err error) error {
+		if err != nil {
+			return nil
+		}
+		os.Chtimes(p, at, at)
+		return nil
+	})
+}
+
+// #3356: a state written before st.Off was recorded (a magpie upgraded
+// from before #6428): the last sync left the library out but wrote no Off
+// mark, so re-enabling the library must still join it like a first sync —
+// the computer's older content gives way to the server's newer one, never
+// the other way round.
+func TestSyncPartTurnedBackOnWithoutOffMark(t *testing.T) {
+	fake, cfg := scopeServer(t)
+
+	// b has older library content and syncs with the library left out:
+	// its first sync starts the folder, without the library
+	b := newComputer(t)
+	b.use(t)
+	saySharedText(t, "older")
+	dateLibrary(t, time.Now().Add(-time.Hour))
+	no := false
+	without := cfg
+	without.Library = &no
+	Configure(without)
+	syncOK(t)
+
+	// a joins with newer library content: the library unset on the server
+	// lets a's go up (#5642)
+	a := newComputer(t)
+	a.use(t)
+	saySharedText(t, "newer")
+	Configure(cfg)
+	syncOK(t)
+	if got := serverBundle(t, fake).Library; got == nil || got.Texts["default"] != "newer" {
+		t.Fatalf("a's library on the server: %+v", got)
+	}
+
+	// b syncs again, still without the library: the state records the
+	// server's library and nothing of it here
+	b.use(t)
+	syncOK(t)
+
+	// the state as a magpie before Off was recorded left it: no Off mark
+	p := filepath.Join(settings.Dir(), "sync-state.json")
+	sb, err := os.ReadFile(p)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var st map[string]any
+	if err := json.Unmarshal(sb, &st); err != nil {
+		t.Fatal(err)
+	}
+	delete(st, "off")
+	ob, err := json.MarshalIndent(st, "", "  ")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(p, ob, 0o600); err != nil {
+		t.Fatal(err)
+	}
+
+	// b enables the library and syncs: the server's newer library comes
+	// in, b's older text replaced and kept aside — never up over it
+	Configure(cfg)
+	v := syncOK(t)
+	if got := serverBundle(t, fake).Library; got == nil || got.Texts["default"] != "newer" {
+		t.Fatalf("b's older library went up over the server's: %+v", got)
+	}
+	if got := sharedText(); got != "newer" {
+		t.Fatalf("b's library after the sync: %q", got)
+	}
+	if v.Notice == nil || !slices.Equal(v.Notice.Here, []string{"library"}) {
+		t.Fatalf("no notice about b's replaced library: %+v", v.Notice)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
