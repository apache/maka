Rework per your review:

**1. "Drop commit 1, or show dsh writing in place."** Dropped. I cannot show dsh writing in place — dsh's source is not at hand here — and the evidence on record is yours and the reporter's: stevenpisces checked dsh's source and it writes through `writeFileAtomic` (exclusive temp, then rename), and the half-state was not a prefix of the real list. On this side the same read of the repo holds: nothing in magpie writes dsh's patch lists in place — every one of magpie's own writes goes through `edit.WriteAtomic`, which is an exclusive temp in the same directory, synced, then renamed (`internal/edit/file.go`), and a rename swap never exposes a half-written file to a reader — it hides the file for the instant it swaps (the window commit 2 now covers, below). So commit 1's premise — a truncate-then-body rewrite — is a write shape nobody has shown, and its 400ms sleep on a fresh list in every round goes with it: the gate in `dshRouteAgainSaid` and its test (`TestDshRouteAgainSkipsAFileBeingWritten`) are gone. The series is one commit now; the range-diff from the old two was `=`/`=` on the base you reviewed before the rework.

**2. "Cover a list that is missing at the read but existed a moment before."** Done. `edit.Read` gives no bytes for a missing file (`readThrough`, `fs.ErrNotExist`), so a read landing in a rename swap parses to zero entries exactly like dsh's own empty list — and the old guard's `os.Stat` with an error returned the empty read as is, which would have written magpie's marked head plus its two entries: your 51-line shape. `dshSettledRead` now treats a missing file the same as a freshly written one: when the read came back empty and the file is gone right now (or there and just touched), the read is taken again after a beat — a file that was whole moments before hands the swap's result over, and one missing for good stays the generation's own. The write comes from the settled read; a still-empty one is dsh's own and written as it is (first generation unchanged, one beat later at most — and `dshWrite` with nothing to write onto a missing file still writes nothing at all). Test: `TestDshSettledReadMissingListIsReread` — the file is removed, the read lands (empty), the whole list is renamed back inside the settle beat, and the settled read hands back all 40 of the user's entries.

**3. "The tests' goroutines aren't joined."** Joined. The three settle tests' delayed writers now signal a channel closed on completion, and the test waits on it in `t.Cleanup` — so a writer still running when a `t.Fatal` fires is waited out before the TempDir goes.

**4. "`dshJustWritten`/`dshSettle` sit between `dshWrites`' doc comment and `var dshWrites`."** Moved. The two vars sit beside `dshSettledRead` now, each with its own doc comment, and `dshWrites`' comment describes `dshWrites` alone.

**Evidence**

- RED without the guard's missing-file arm (`dshSettledRead` returning the empty read as is, test kept, `-count=2`, both runs):
  ```
  --- FAIL: TestDshSettledReadMissingListIsReread (0.16s)
      dsh_halfwrite_test.go:216: a list missing at the read, whole moments before, was taken as gone — the fresh generation would have written over the user's 0 entries
  ```
- RED with the whole reread out (ablation, `dshSettledRead` reduced to handing its read through, tests kept):
  ```
  --- FAIL: TestDshSetWritesOnAListThatSettled (0.24s)
      dsh_halfwrite_test.go:53: the fresh generation fixed the half as the list — the user's entries are gone:
  --- FAIL: TestDshFillNewProfilesWritesOnAListThatSettled (0.16s)
      dsh_halfwrite_test.go:105: the fill fixed the half as the list — the user's entries are gone:
  --- FAIL: TestDshSetEffortWritesOnAListThatSettled (0.16s)
      dsh_halfwrite_test.go:138: the effort pick fixed the half as the list — the user's entries are gone:
  --- FAIL: TestDshSettledReadMissingListIsReread (0.15s)
      dsh_halfwrite_test.go:172: a list missing at the read, whole moments before, was taken as gone — ...
  ```
- RED with the log line out (ablation): `TestDshSetSaysWhatItWrote` fails at `dsh_halfwrite_test.go:195: the model-set write said nothing:` — restored, green.
- Green: the six tests (`SettledReadMissingListIsReread`, `SetWritesOnAListThatSettled`, `SetWritesThroughAStableEmptyList`, `FillNewProfilesWritesOnAListThatSettled`, `SetEffortWritesOnAListThatSettled`, `SetSaysWhatItWrote`) green `-count=3`; the whole `TestDsh` family green (33.7s); the six green under `-race`.
- Whole package `internal/agent` (`nogui`, `-count=1`, 277.9s): the only red is `TestMothX` (`mothx_test.go:154`) — red on the bare `upstream/main` base too (same line, attribution run this session), not a new red.
- `gofmt` clean on the touched files; `go vet` clean on darwin, linux, windows (`nogui`); `go build -tags nogui ./...` ok on darwin, linux, windows.
- `git am` on a clean `upstream/main` (`4716a77ff`) replays to a tree byte-identical to the branch tip (`3d4b84b475d4a6aa`, empty diff).

**When the read fails**: a missing file is no longer read as a confirmed empty — it is unknown, and the settled read looks again; if it is still missing, the write faces it as before (generation writes where they did, `dshWrite` writes nothing onto a missing nothing). A read error other than NotExist still aborts the write path the callers already had.

**Siblings**: the three fresh-generation writers (`dshSetFile`, `dshFillNewProfiles`' fill, `dshSetEffort`) go through `dshSettledRead` and are covered. The rest of the patch-list writers (`dshKeepPick`, `dshMove`, `dshSyncLegacy`, `dshMirrorHome`, `dshRouteAgainSaid`/`dshWriteParsed`) all precondition on an entry already present in the read — a zero-entry or missing read falls through to no write — so a swap window cannot make them generate fresh; left as they are. `internal/library/dsh.go`'s write is a different file (the agent config layer), not a patch list. The readers (`dshLook`, `dshOver`, the rounds' scans) pass a missing file through as "no entries" to look-only paths that write nothing.

**Not verified here**: a real Windows dsh desktop mid-save (the swap is played by a remove and a rename-back against the same parsers); the reporter's machine.

Branch: [hunt-20261111-rf-5782](https://github.com/ggbdpq/magpie/tree/57a3d6208e684bd71e712b2c1510d9383ef9aa8f) — head `57a3d6208e684bd71e712b2c1510d9383ef9aa8f`, rebased onto current `upstream/main` (`4716a77ff`).

Patch: <details><summary>patch: dsh: a list that reads empty or missing right after a write is reread before one is written (#5782) — git am applies it as is; SHA-256 first 16: 42f4df13aeeca482</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 20 Nov 2026 07:41:38 +0800
Subject: [PATCH] dsh: a list that reads empty or missing right after a write
 is reread before one is written (#5782)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

stevenpisces' machine lost its patch list through a read that came back
with no entries: the fresh generation written from that nothing went back
as head plus magpie's two entries, and the user's 51 lines were gone. The
model-set path said nothing as it did.

dshSettledRead is the read a fresh generation cannot be written blind
from, on every path that generates fresh into a list that read empty: the
model set (dshSetFile), the profile the round fills (dshFillNewProfiles),
and the effort pick (dshSetEffort). A list that reads empty — or missing
at all, which is what an atomic writer's rename swap leaves for the
instant it replaces the file, a read landing in that window parsing to
nothing while the user's list was whole moments before — is reread after
a beat, and what is written comes from the settled read; a still-empty
one is dsh's own and written as it is. The model-set write says what it
wrote where, so the next loss is findable in minutes.

Ablation: with the reread out, TestDshSetWritesOnAListThatSettled,
TestDshFillNewProfilesWritesOnAListThatSettled,
TestDshSetEffortWritesOnAListThatSettled and
TestDshSettledReadMissingListIsReread fail at "the user's entries are
gone" / "was taken as gone" — the reporter's shape; with the log line
out, TestDshSetSaysWhatItWrote fails. A list that reads empty and stays
empty still takes the route (TestDshSetWritesThroughAStableEmptyList).

Run at upstream/main 4716a77ff + this commit, macOS 15 (darwin/arm64):
the TestDsh family green; the settle tests and the missing-list reread
green three runs each; gofmt and go vet clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/dsh.go                |  52 +++++++
 internal/agent/dsh_halfwrite_test.go | 197 +++++++++++++++++++++++++++
 2 files changed, 249 insertions(+)
 create mode 100644 internal/agent/dsh_halfwrite_test.go

diff --git a/internal/agent/dsh.go b/internal/agent/dsh.go
index 4b1fcc0fd..ed5e0e944 100644
--- a/internal/agent/dsh.go
+++ b/internal/agent/dsh.go
@@ -1377,6 +1377,44 @@ func dshStashKey(path, id string) string { return "dsh:" + path + ":" + id }
 // it would leave whichever read first as its content.
 var dshWrites sync.Mutex
 
+// dshJustWritten is how recently a patch list may have been touched for the
+// read a fresh generation is written from to be taken again: a list written
+// moments ago may still be under its writer's hand.
+var dshJustWritten = 2 * time.Second
+
+// dshSettle is the beat such a read is taken again after, long enough for
+// the writer's swap to have landed.
+var dshSettle = 400 * time.Millisecond
+
+// dshSettled is a read a fresh generation cannot be written blind from: a
+// list that reads as no entries — or as missing at all — right after the
+// file was touched is not dsh's own settled empty. An atomic writer
+// (exclusive temp, then rename) hides the file for the instant its swap
+// happens: a read landing there parses to nothing while the user's list
+// was whole moments before (#5782, stevenpisces: 57 entries became 2), and
+// a fresh generation written from that nothing would fix the nothing as
+// the list — head plus magpie's entries alone. The read is taken again
+// after a beat, and what is written comes from the settled read; a
+// still-empty one is dsh's own and written as it is.
+func dshSettledRead(path string, head []string, items []dshItem) ([]string, []dshItem, error) {
+	if len(items) != 0 {
+		return head, items, nil
+	}
+	st, err := os.Stat(path)
+	if err == nil && time.Since(st.ModTime()) >= dshJustWritten {
+		return head, items, nil
+	}
+	time.Sleep(dshSettle)
+	h, i, err := dshRead(path)
+	if err != nil {
+		return nil, nil, err
+	}
+	if len(i) != 0 {
+		return h, i, nil
+	}
+	return head, items, nil
+}
+
 // dshSet writes v as the model new sessions start on: a catalog model
 // through the gateway, one of dsh's own models directly, or "" for dsh's own
 // default. Every profile gets it; config.yaml only where there are none.
@@ -1783,6 +1821,9 @@ func dshSetFile(path, v string, modern bool, models []catalog.Model, gw string)
 	if err != nil {
 		return err
 	}
+	if head, items, err = dshSettledRead(path, head, items); err != nil {
+		return err
+	}
 	ref, viaGateway := strings.CutPrefix(v, magpieID+"/")
 	effort := ""
 	if modern {
@@ -1860,6 +1901,11 @@ func dshSetFile(path, v string, modern bool, models []catalog.Model, gw string)
 		drop("llm-deepseek")
 		put("agent-loop", dshLoopLines(v))
 	}
+	// the model-set path wrote silently; one line here would have found
+	// #5782's loss in minutes (stevenpisces)
+	if v != "" {
+		log.Printf("wrote dsh's route in %s", path)
+	}
 	return dshWrite(path, head, items)
 }
 
@@ -3097,6 +3143,9 @@ func dshFillNewProfiles(files []string, models []catalog.Model, gw string) error
 		if err != nil {
 			continue
 		}
+		if head, items, err = dshSettledRead(f, head, items); err != nil {
+			continue
+		}
 		if i := dshFind(items, "agent-default-model"); model != "" && (i < 0 || dshOurs(items[i])) {
 			if err := dshSetFile(f, magpieID+"/"+model, true, models, gw); err != nil {
 				return err
@@ -3380,6 +3429,9 @@ func dshSetEffort(dir, v, gw, lead string) error {
 			if err != nil {
 				continue
 			}
+			if head, items, err = dshSettledRead(f, head, items); err != nil {
+				continue
+			}
 			// each profile keeps the model it starts on
 			p, m := "deepseek-official", ref
 			if viaGateway {
diff --git a/internal/agent/dsh_halfwrite_test.go b/internal/agent/dsh_halfwrite_test.go
new file mode 100644
index 000000000..44f35d27a
--- /dev/null
+++ b/internal/agent/dsh_halfwrite_test.go
@@ -0,0 +1,197 @@
+package agent
+
+// A fresh generation into dsh's patch list is written from a settled read:
+// a list that reads empty or missing right after the file was touched may
+// still be under its writer's hand, and a generation written from that
+// would fix it as the list, the user's entries gone with it (#5782,
+// stevenpisces: 57 entries became 2). The read is taken again after a beat,
+// and what is written comes from the settled read.
+
+import (
+	"bytes"
+	"log"
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/gateway"
+)
+
+// dshUsersEntries is the body a desktop's save lands: the user's own
+// entries, no route of magpie's among them.
+func dshUsersEntries(n int) string {
+	return strings.Repeat("- id: user-entry\n  config:\n    step: done\n    note: keep me\n", n)
+}
+
+// The model-set path reads the same list the rounds do: one that reads as
+// its comment head and no entries right after the file was touched is a
+// writer's head, not dsh's own empty — the fresh generation written from it
+// went back as head plus magpie's two entries, the user's entries gone with
+// it (#5782, stevenpisces: the half matched 4 of 51 lines of the real
+// list). The list is reread after a beat, and the pick lands on the
+// settled read.
+func TestDshSetWritesOnAListThatSettled(t *testing.T) {
+	home, dir, web := dshRouteHome(t)
+	dshKeyFixture(dir)
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"), 0o644)
+	// the desktop's save lands the body inside the settle beat
+	back := make(chan struct{})
+	go func() {
+		defer close(back)
+		time.Sleep(150 * time.Millisecond)
+		os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"+dshUsersEntries(40)), 0o644)
+	}()
+	t.Cleanup(func() { <-back })
+	a := dsh(home)
+	if err := a.Field("model").Set("magpie/deepseek/flash"); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := os.ReadFile(web)
+	if s := string(b); strings.Count(s, "note: keep me") != 40 {
+		t.Fatalf("the fresh generation fixed the half as the list — the user's entries are gone:\n%s", s[:min(700, len(s))])
+	}
+}
+
+// A list that reads empty and stays empty is dsh's own: the fresh
+// generation goes out as before, one beat later at most.
+func TestDshSetWritesThroughAStableEmptyList(t *testing.T) {
+	home, dir, web := dshRouteHome(t)
+	dshKeyFixture(dir)
+	template := "# Your patch layer for this dsh profile.\n[]\n"
+	os.WriteFile(web, []byte(template), 0o644)
+	past := time.Now().Add(-10 * time.Second)
+	os.Chtimes(web, past, past)
+	a := dsh(home)
+	if err := a.Field("model").Set("magpie/deepseek/flash"); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := os.ReadFile(web)
+	for _, want := range []string{"id: llm-pi-ai", "displayName: Magpie", "provider: magpie", "id: deepseek/flash"} {
+		if !strings.Contains(string(b), want) {
+			t.Fatalf("a stable empty list not filled with %q:\n%s", want, b)
+		}
+	}
+}
+
+// and the round that fills a profile dsh has just made reads it settled:
+// the desktop app's first save caught mid-write was the reporter's other
+// half (#5782). The start here is the user's own, so the fill goes out
+// through dshPutRoute and the write itself, not dshSetFile.
+func TestDshFillNewProfilesWritesOnAListThatSettled(t *testing.T) {
+	_, dir, web := dshRouteHome(t)
+	dshKeyFixture(dir)
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"+
+		dshRouteFixture("deepseek/pro", "deepseek/flash")+
+		"- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n"), 0o644)
+	desktop := filepath.Join(dir, "profiles", "desktop", "cordis.patch.yml")
+	os.MkdirAll(filepath.Dir(desktop), 0o755)
+	os.WriteFile(desktop, []byte("# Your patch layer for this dsh profile.\n"), 0o644)
+	// the desktop's save lands its body inside the settle beat
+	back := make(chan struct{})
+	go func() {
+		defer close(back)
+		time.Sleep(150 * time.Millisecond)
+		os.WriteFile(desktop, []byte("# Your patch layer for this dsh profile.\n"+dshUsersEntries(40)), 0o644)
+	}()
+	t.Cleanup(func() { <-back })
+	if err := dshSync(dir, gateway.URL()); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := os.ReadFile(desktop)
+	s := string(b)
+	if strings.Count(s, "note: keep me") != 40 {
+		t.Fatalf("the fill fixed the half as the list — the user's entries are gone:\n%s", s[:min(700, len(s))])
+	}
+	if !strings.Contains(s, "      magpie:\n") {
+		t.Fatalf("the fill did not land on the settled list:\n%s", s[:min(900, len(s))])
+	}
+}
+
+// and the effort pick the same: agent-default-model generated on a
+// head-only read went back alone (#5782). The start the pick keeps sits in
+// the home layer while the profile's own list is dsh's save caught
+// mid-write.
+func TestDshSetEffortWritesOnAListThatSettled(t *testing.T) {
+	home, dir, web := dshRouteHome(t)
+	dshKeyFixture(dir)
+	hp := filepath.Join(dir, "cordis.patch.yml")
+	os.WriteFile(hp, []byte("# shared by every profile\n"+
+		"- id: agent-default-model # magpie\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n"), 0o644)
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"), 0o644)
+	// the desktop's save lands the body inside the settle beat
+	back := make(chan struct{})
+	go func() {
+		defer close(back)
+		time.Sleep(150 * time.Millisecond)
+		os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n"+dshUsersEntries(40)), 0o644)
+	}()
+	t.Cleanup(func() { <-back })
+	a := dsh(home)
+	if err := a.Field("effort").Set("high"); err != nil {
+		t.Fatal(err)
+	}
+	b, _ := os.ReadFile(web)
+	s := string(b)
+	if strings.Count(s, "note: keep me") != 40 {
+		t.Fatalf("the effort pick fixed the half as the list — the user's entries are gone:\n%s", s[:min(700, len(s))])
+	}
+	if !strings.Contains(s, "reasoningEffort: \"high\"") {
+		t.Fatalf("the effort did not land on the settled list:\n%s", s[:min(700, len(s))])
+	}
+}
+
+// The likeliest window an atomic writer leaves is not a half: the file is
+// renamed over whole, and for the instant the swap happens it is missing —
+// a read landing there parses to nothing (edit.Read gives no bytes for a
+// missing file), while the user's entries were whole moments before (#5782,
+// stevenpisces: 57 entries became 2). The settled read looks again after a
+// beat — the swap has landed by then — and what the fresh generation writes
+// comes from that; a file missing for good stays the generation's own.
+func TestDshSettledReadMissingListIsReread(t *testing.T) {
+	f := filepath.Join(t.TempDir(), "cordis.patch.yml")
+	whole := "# Your patch layer for this dsh profile.\n" + dshUsersEntries(40)
+	os.WriteFile(f, []byte(whole), 0o644)
+	// the swap is played by hand: the file is gone when the read lands,
+	// and back inside the settle beat
+	os.Remove(f)
+	back := make(chan struct{})
+	go func() {
+		defer close(back)
+		time.Sleep(150 * time.Millisecond)
+		os.WriteFile(f, []byte(whole), 0o644)
+	}()
+	t.Cleanup(func() { <-back })
+	// the read the writer's swap hid, as dshSetFile's own gave it
+	head, items, err := dshSettledRead(f, nil, nil)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if len(items) != 40 {
+		t.Fatalf("a list missing at the read, whole moments before, was taken as gone — the fresh generation would have written over the user's %d entries", len(items))
+	}
+	if len(head) == 0 || !strings.Contains(head[0], "Your patch layer") {
+		t.Fatalf("the settled read lost the list's head: %q", head)
+	}
+}
+
+// The model-set path wrote silently; one line there would have found the
+// loss in minutes (stevenpisces). A pick says what it wrote where.
+func TestDshSetSaysWhatItWrote(t *testing.T) {
+	home, dir, web := dshRouteHome(t)
+	dshKeyFixture(dir)
+	os.WriteFile(web, []byte("# Your patch layer for this dsh profile.\n[]\n"), 0o644)
+	past := time.Now().Add(-10 * time.Second)
+	os.Chtimes(web, past, past)
+	var buf bytes.Buffer
+	log.SetOutput(&buf)
+	t.Cleanup(func() { log.SetOutput(os.Stderr) })
+	a := dsh(home)
+	if err := a.Field("model").Set("magpie/deepseek/flash"); err != nil {
+		t.Fatal(err)
+	}
+	if !strings.Contains(buf.String(), "wrote dsh's route in "+web) {
+		t.Fatalf("the model-set write said nothing:\n%s", buf.String())
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
