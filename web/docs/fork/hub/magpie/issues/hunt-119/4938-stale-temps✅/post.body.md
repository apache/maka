## Summary

Bug 1's file face: `steady.WriteFile` now reaps the stale temps earlier writes of the same file left beside it — its own `.<file>.<digits>` shape and `edit.WriteAtomic`'s `.<file>.<digits>.tmp` alike — through one reaper both writers share (`steady.RemoveStaleTemps`). Nothing reaped a steady temp before, so a start-up that exits mid-write left hundreds beside magpie's own files over a run, and every `O_EVTONLY` descriptor the directory watcher holds per file with them (your 758 temps, 839 descriptors).

This lands beside your Bug 2 (b295d1196, v0.1.2785): with the serve-side wait, the repeated mid-write exits stop being made, and with this, the ones already on disk and any that still happen are taken on the next write of the same file.

## Reproduce

The test's shape, taken from your chain: a file beside which stand this package's crash-left temp and edit's `.tmp` one, both an hour old, a younger one, and another file's temp (`.quotas.json.x.012` is `.quotas.json.x`'s). One `steady.WriteFile` takes the two stale ones and leaves the younger and the foreign one. On base, both stale temps stay — the exact accumulation you counted.

## Root cause

`edit.WriteAtomic` reaped beside each write (`removeStaleTemps`, only `.tmp`-shaped ones); `steady.WriteFile` — the writer your report names, used for `quotas.json`, `plugin-auth.json` and the rest of magpie's own files — never did. The reaping lived beside the write, so a process killed mid-write left its temps forever; the 10-minute age in the moved rule still holds (a write takes milliseconds; one older belongs to no write still going on), and the remainder check (`digits`, then `digits` + `.tmp`) keeps another file's temps standing.

## Fix

`steady.RemoveStaleTemps` is the old `removeStaleTemps` moved and widened: prefix `.<file>.`, remainder all digits (this package's `os.CreateTemp` shape) or digits + `.tmp` (edit's), older than ten minutes, removed; `steady.WriteFile` calls it once its write went through, and `edit.WriteAtomic`'s two call sites call the same function — one reaper, both shapes, every folder the two writers share. A stalled write that loses its temp to the reaper fails its rename and leaves the file as it was (edit's comment carried over), so the worst case is today's, not worse.

## Verification

| Check | Result |
| --- | --- |
| `TestWriteFileReapsStaleTemps` on base `c86fa2a34` | FAIL: `.quotas.json.123` and `.quotas.json.789.tmp` still there after the write |
| the same with the change | green: the two stale shapes reaped, the younger `.456` and the foreign `.quotas.json.x.012` stand |
| `go test ./internal/edit -count=1`, `./internal/steady -count=1` | ok |
| ablation: product files reverted to base, tests kept | both temps stay again; restored: green |
| rebase onto `78cd4e6dd` and re-run | green |
| the reaper tests with `-race` | ok |
| `gofmt -l`, `go vet -tags nogui` (darwin, GOOS=linux, GOOS=windows), `go build -tags nogui` (darwin, linux, windows) | clean |

**Not verified**: your machine's 758-file directory — the reaper takes a file's temps when that file is next written, so an existing pile shrinks as each of magpie's files is written again, and the descriptors go with the files; no live `lsof` was taken here. Your Bug 3's CPU face (fsnotify's per-file descriptors while the pile stands) is unchanged by this until the pile goes.

**Left**: the watcher holds one descriptor per file in `~/.config/magpie` — with the pile gone the count falls back to the live files; if the per-file watching itself is worth changing (one descriptor per directory), that is Bug 3's face and stays open.

---
**Source**: reported in #4938 (ox01024); found on the code level by reading, as the issue says of itself.

**Red without the fix** (base `c86fa2a34`): with `internal/steady/steady.go` and `internal/edit/file.go` reverted and the new test kept, `go test ./internal/steady -run TestWriteFileReapsStaleTemps` fails:
```
--- FAIL: TestWriteFileReapsStaleTemps (0.02s)
    write_test.go:100: .quotas.json.123: stays true, want false
    write_test.go:100: .quotas.json.789.tmp: stays true, want false
```
With the fix: `ok`.

**Siblings**: `rg -n "CreateTemp" internal/` — the two writers are `steady.WriteFile` and `edit.WriteAtomic`; both reap through the one function now. `plugin.commitProviders`' unconditional write (your 1.3) and `provider.keepLast`'s per-check rewrites make the temps *faster*; the reaper is what takes them — those faces are untouched. `filememo.Watch`'s per-file descriptors are Bug 3's face (open).

**When the read fails**: a temp whose `Info` fails stays; a directory read that fails reaps nothing; a temp made by another program (remainder not digits) is never touched.

**Not verified**: real Windows; the FD count on a live instance after the pile goes.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/4938-stale-temps](https://github.com/ggbdpq/magpie/tree/fix/4938-stale-temps) (head `8868ec6df`).

**Patch**: <details><summary>patch: steady: a served write reaps the stale temps earlier writes left beside the file (#4938) — git am applies it as is; SHA-256 first 16: 488d4b1d8119f25c</summary>

```patch
From 8868ec6df55477b6a9652558a575efd488471bd7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 18:16:50 +0800
Subject: [PATCH] steady: a served write reaps the stale temps earlier writes
 left beside the file (#4938)

What changed: steady.WriteFile, on a write that went through, removes
the temp files a crashed or failed write of the same file left beside
it - its own .<file>.<digits> shape and edit.WriteAtomic's
.<file>.<digits>.tmp alike, both old enough (10 minutes) to belong to
no write still going on, and only ones whose remainder is digits, so
another file's temps (.models.yml.bak.1.tmp is models.yml.bak's) stand.
edit.WriteAtomic reaps through the same function: one reaper, both
shapes, every folder magpie writes its own files in. Nothing reaped a
steady temp before - edit reaped only its own .tmp shape - so a
multi-instance start-up exiting mid-write (the reaping exists beside
each write, and nothing swept) left hundreds beside magpie's own files
over a run, and every O_EVTONLY descriptor the directory watcher holds
per file with them (#4938 Bug 1: 758 temps, 839 descriptors). A write
younger than the ten minutes stays, as another write may still be on
it; a stalled write that loses its temp here fails its rename and
leaves the file as it was.

Bug 2 beside this one is yetone's b295d1196 (v0.1.2785); Bug 3 stays
open.

Run:
- go test ./internal/steady -run TestWriteFileReapsStaleTemps -count=1
  RED before (the .123 and .789.tmp temps a write leaves behind stay),
  green after: this package's shape and edit's reaped, a younger one
  and another file's stay.
- go test ./internal/edit -count=1, ./internal/steady -count=1: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/edit/file.go         | 43 +++---------------------------
 internal/steady/steady.go     | 49 ++++++++++++++++++++++++++++++++++-
 internal/steady/write_test.go | 49 +++++++++++++++++++++++++++++++++++
 3 files changed, 100 insertions(+), 41 deletions(-)

diff --git a/internal/edit/file.go b/internal/edit/file.go
index a7df5ba10..5edd7eb00 100644
--- a/internal/edit/file.go
+++ b/internal/edit/file.go
@@ -11,10 +11,8 @@ import (
 	"io/fs"
 	"os"
 	"path/filepath"
-	"strings"
 	"sync"
 	"sync/atomic"
-	"time"
 
 	"github.com/tidwall/jsonc"
 	"github.com/yetone/magpie/internal/appdir"
@@ -128,7 +126,7 @@ func Filtered(f func(path string, data []byte) []byte, fn func() error) error {
 // preserved. When path is a symlink (a config kept in a dotfiles repo) the
 // file it points at is written and the link stays; a file with other hard
 // links is written in place, see writeInPlace. Once written, temp files
-// earlier writes of path left behind go, see removeStaleTemps.
+// earlier writes of path left behind go, see steady.RemoveStaleTemps.
 func WriteAtomic(path string, data []byte) error {
 	path, err := Target(path)
 	if err != nil {
@@ -154,7 +152,7 @@ func WriteAtomic(path string, data []byte) error {
 			if err := writeInPlace(f, data); err != nil {
 				return err
 			}
-			removeStaleTemps(path)
+			steady.RemoveStaleTemps(path)
 			return nil
 		}
 		// A file that can't be opened for writing (mode 0444, or read-only
@@ -215,7 +213,7 @@ func WriteAtomic(path string, data []byte) error {
 		cleanup()
 		return err
 	}
-	removeStaleTemps(path)
+	steady.RemoveStaleTemps(path)
 	return nil
 }
 
@@ -277,41 +275,6 @@ func writeInPlace(f *os.File, data []byte) error {
 	return nil
 }
 
-// staleTemp is how long a temp file beside a config goes untouched before
-// the next write of that config takes it for one a crash left. A write
-// takes milliseconds, so a temp file that old belongs to no write still
-// going on.
-const staleTemp = 10 * time.Minute
-
-// removeStaleTemps removes the temp files that earlier writes of path left
-// beside it when they crashed or failed part way, once a later write has
-// gone through: the file then holds newer text than any of them. One
-// younger than staleTemp stays, as another write may still be using it.
-// Should a write stall longer than that (a laptop asleep mid-write) and
-// lose its temp file here, its rename fails and leaves the file as it was,
-// or, writing in place, it only loses the spare copy of its text.
-func removeStaleTemps(path string) {
-	dir, prefix := filepath.Dir(path), "."+filepath.Base(path)+"."
-	es, err := os.ReadDir(dir)
-	if err != nil {
-		return
-	}
-	for _, e := range es {
-		mid, ok := strings.CutPrefix(e.Name(), prefix)
-		if ok {
-			mid, ok = strings.CutSuffix(mid, ".tmp")
-		}
-		// os.CreateTemp puts digits for the *; anything else is another
-		// file's, say .models.yml.bak.1.tmp is models.yml.bak's
-		if !ok || mid == "" || strings.Trim(mid, "0123456789") != "" {
-			continue
-		}
-		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > staleTemp {
-			_ = os.Remove(filepath.Join(dir, e.Name()))
-		}
-	}
-}
-
 // Target is the file a write to path should replace: path itself, or,
 // when path is a symlink, the file at the end of its links — the path it
 // names even when nothing is there yet. Renaming over the link instead
diff --git a/internal/steady/steady.go b/internal/steady/steady.go
index e60a6f4db..bc8d29b7f 100644
--- a/internal/steady/steady.go
+++ b/internal/steady/steady.go
@@ -16,6 +16,7 @@ import (
 	"os"
 	"path/filepath"
 	"runtime"
+	"strings"
 	"syscall"
 	"time"
 )
@@ -153,6 +154,8 @@ var Sync = (*os.File).Sync
 // machine that went down between the two left logins.json and
 // plugin-auth.json at their full length with every byte zero (#1505). A
 // write or flush that fails removes the temp file and leaves p as it was.
+// A write that is served takes the stale temps earlier writes left beside
+// p when they died (RemoveStaleTemps) along with it.
 func WriteFile(p string, b []byte, perm fs.FileMode) error {
 	tmp, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+".*")
 	if err != nil {
@@ -173,6 +176,50 @@ func WriteFile(p string, b []byte, perm fs.FileMode) error {
 	}
 	if err != nil {
 		os.Remove(tmp.Name())
+		return err
+	}
+	RemoveStaleTemps(p)
+	return nil
+}
+
+// staleTemps is how long a temp file beside a file goes untouched before
+// the next write of that file takes it for one a crash left. A write takes
+// milliseconds, so a temp file that old belongs to no write still going on.
+const staleTemps = 10 * time.Minute
+
+// RemoveStaleTemps removes the temp files that earlier writes of path left
+// beside it when they died or failed part way, once a later write has gone
+// through: the file then holds newer text than any of them (#4938 — a
+// start-up that exits mid-write left hundreds beside magpie's own files,
+// and every file descriptor a directory watcher holds on them with it).
+// One younger than staleTemps stays, as another write may still be using
+// it. Should a write stall longer than that (a laptop asleep mid-write)
+// and lose its temp file here, its rename fails and leaves the file as it
+// was, or, writing in place, it only loses the spare copy of its text.
+func RemoveStaleTemps(path string) {
+	dir, prefix := filepath.Dir(path), "."+filepath.Base(path)+"."
+	es, err := os.ReadDir(dir)
+	if err != nil {
+		return
+	}
+	for _, e := range es {
+		mid, ok := strings.CutPrefix(e.Name(), prefix)
+		if !ok {
+			continue
+		}
+		// os.CreateTemp puts digits for the *: this package's temps are
+		// digits alone, edit.WriteAtomic's digits and ".tmp" (which the
+		// reaping of one file's temps takes with the other's, the two
+		// writers sharing the folder); anything else is another file's,
+		// say .models.yml.bak.1.tmp is models.yml.bak's
+		if t, hasTmp := strings.CutSuffix(mid, ".tmp"); hasTmp {
+			mid = t
+		}
+		if mid == "" || strings.Trim(mid, "0123456789") != "" {
+			continue
+		}
+		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > staleTemps {
+			_ = os.Remove(filepath.Join(dir, e.Name()))
+		}
 	}
-	return err
 }
diff --git a/internal/steady/write_test.go b/internal/steady/write_test.go
index 434faf8f5..bcdb972ec 100644
--- a/internal/steady/write_test.go
+++ b/internal/steady/write_test.go
@@ -5,6 +5,7 @@ import (
 	"os"
 	"path/filepath"
 	"testing"
+	"time"
 )
 
 // A file is flushed to the disk before it is renamed over the old one: a
@@ -52,3 +53,51 @@ func TestWriteFileSyncsBeforeRename(t *testing.T) {
 		t.Fatalf("a failed write left %v", left)
 	}
 }
+
+// A write that died between making its temp file and renaming it leaves the
+// temp beside the file: a multi-instance start-up exiting mid-write made
+// hundreds of them beside magpie's own files over a run, and nothing took
+// them — edit.WriteAtomic reaps its temps beside the file it wrote, but
+// steady.WriteFile never did (#4938). A served write reaps the ones old
+// enough to belong to no write still going on, its own shape and edit's
+// alike, and leaves a younger one alone and another file's temp alone.
+func TestWriteFileReapsStaleTemps(t *testing.T) {
+	dir := t.TempDir()
+	p := filepath.Join(dir, "quotas.json")
+	if err := os.WriteFile(p, []byte(`{}`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	old := time.Now().Add(-time.Hour)
+	temps := []struct {
+		name         string
+		stale, stays bool
+	}{
+		{".quotas.json.123", true, false},     // this package's shape, a crash left it
+		{".quotas.json.456", false, true},     // another write may still be on it
+		{".quotas.json.789.tmp", true, false}, // edit.WriteAtomic's shape, the same file's
+		{".quotas.json.x.012", true, true},    // .quotas.json.x's, not quotas.json's
+	}
+	for _, tt := range temps {
+		f := filepath.Join(dir, tt.name)
+		if err := os.WriteFile(f, []byte("half"), 0o600); err != nil {
+			t.Fatal(err)
+		}
+		if tt.stale {
+			if err := os.Chtimes(f, old, old); err != nil {
+				t.Fatal(err)
+			}
+		}
+	}
+	if err := WriteFile(p, []byte(`{"a":1}`), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	if b, err := os.ReadFile(p); err != nil || string(b) != `{"a":1}` {
+		t.Fatalf("file = %q, %v", b, err)
+	}
+	for _, tt := range temps {
+		_, err := os.Stat(filepath.Join(dir, tt.name))
+		if stays := err == nil; stays != tt.stays {
+			t.Errorf("%s: stays %v, want %v", tt.name, stays, tt.stays)
+		}
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>
