## Summary

`takeEdits` (`internal/library/skill_edits.go`) reads the shared copy too: an edit made in `~/.agents/skills` — where no link could be made (Windows without the right to) and the entry is a marked copy — is taken into the library as one in an agent's copy is, before `syncShared` sets the stale copy aside. The edit reaches every other agent's copy with the sync, instead of ending up only in the backups.

## Reproduce

The issue's shape, exercised on this machine by standing in for the Windows copy with what `link`'s fallback and `copyIn` put there — a marked copy (`copied from … by magpie`): the setting on, the shared entry a marked copy, a file added to it, one sync. On base `db7c57670` the library's skill has no such file, and the shared entry no longer does either — the copy was replaced, the edit only in the backups.

## Root cause

`takeEdits` scans the targets — the agents' own skills folders — and nothing else. The shared entry is no target's when no agent holds that folder, so its copy is never read; `syncShared` (later in the sync) then finds a copy whose hash isn't the library's and does what a stale copy gets: set aside, made again. The taking runs first on purpose ("an edit … goes to the library first, for the others to get rather than be undone") — the shared copy just was never in its round.

## Fix

After the targets, `takeEdits` reads the shared entry with the same machinery — `copiedAt`/`changedAt`/`sameTree`, the newest edit winning unless the library changed after it, losers kept aside — under the label the shared face already uses (`"agents"`, as `syncShared` reports there). It runs only where the setting keeps skills shared, the entry is magpie's marked copy (never a link — a link's target is the library's own folder), and no target already covered that folder (`seen`, so an agent whose own skills folder is `~/.agents/skills` — Kimi Code, Goose — isn't read twice). The rest is unchanged: the winner is mirrored into the library, `copyIn` re-marks the copy in place, and `syncShared` finds it fresh.

## Verification

| Check | Result |
| --- | --- |
| `TestEditInSharedCopyTaken` on base `db7c57670` | FAIL: "the edit in the shared copy wasn't taken into the library" and "the shared entry lost the edit" |
| the same with the change | green: the library's skill carries the edit, the shared entry stays magpie's and keeps it |
| `go test ./internal/library -count=1` | ok (67 s) |
| `TestSkillsWhereShared`, `TestAgentsSkillsFolders`, `TestEditInSharedCopyTaken` with `-race` | ok |
| ablation: `skill_edits.go` reverted to base, tests kept | both failure lines again; restored: green |
| `gofmt -l`, `go vet -tags nogui` (darwin, GOOS=linux, GOOS=windows), `go build -tags nogui` (darwin, linux, windows) | clean |

**Not verified**: Windows without the right to make links — the marked copy the test stands in with is the one both copy paths (`link`'s fallback and `copyIn`) write, mark and all; a real Windows box isn't here (the issue says the same of its own report).

**Left**: none known. A shared copy is only made where links can't be; where they can, the entry is a link to the library's own folder and an edit there is an edit of the library's.

---
**Source**: reported in #4958 (yetone, found reading the code while building the setting; not yet reproduced on the Windows box).

**Red without the fix** (base `db7c57670`): with `internal/library/skill_edits.go` reverted and the new test kept, `go test ./internal/library -run TestEditInSharedCopyTaken` fails:
```
--- FAIL: TestEditInSharedCopyTaken (2.00s)
    shared_edit_take_test.go:41: the edit in the shared copy wasn't taken into the library
    shared_edit_take_test.go:49: the shared entry lost the edit
```
With the fix: `ok`.

**Siblings**: the shared entry's writers — `syncShared` (sets a stale copy aside, then copies again — unchanged, and now second), `sweepShared` (takes out what the setting no longer keeps — unchanged, runs after), `relink`/`link`'s copy fallback (make the marked copy — unchanged). `takeEdits`'s agent-face loop is unchanged; the shared scan is a separate block after it, gated on the same `ours`/`linked`/mark checks the agent face uses.

**When the read fails**: a shared copy whose `changedAt` fails is reported as the shared face's failure (`"agents"`, `skill:<name>`), the skill blocked from the shared sync this round — as an agent copy's failure is; a copy with no mark is nobody's to read, as before.

**Not verified**: real Windows box.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [fix/4958-shared-skill-edits](https://github.com/ggbdpq/magpie/tree/fix/4958-shared-skill-edits) (head `12d9f8c94`).

**Patch**: <details><summary>patch: library: an edit made in the shared copy of a skill is taken into the library (#4958) — git am applies it as is; SHA-256 first 16: 9d21fce9738d414f</summary>

```patch
From 12d9f8c94619f9c7be7be383e13a0f8169e5d7ab Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 07:40:48 +0800
Subject: [PATCH] library: an edit made in the shared copy of a skill is taken
 into the library (#4958)

What changed: takeEdits reads the shared copy too - ~/.agents/skills
where no link could be made (Windows without the right to), the entry a
marked copy - as it reads an agent's copy: anything newer than the
copy's mark is an edit, the newest one taken unless the library changed
after it, losers kept aside. An agent whose own folder ~/.agents/skills
is has its copy read as it was; the shared scan only runs where no
target already covered that folder. syncShared, which sets a stale copy
aside before copying again, runs after, so the edit is in the library
and every other agent's copy first.

Run:
- go test ./internal/library -run TestEditInSharedCopyTaken -count=1
  RED before: the edit wasn't taken (the library's skill has no
  notes.md) and the shared entry lost it; green after.
- go test ./internal/library -count=1: ok (66s).
- gofmt, go vet -tags nogui (darwin/linux/windows), builds
  (darwin/linux/windows), the new test with -race: clean.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/shared_edit_take_test.go | 51 +++++++++++++++++++++++
 internal/library/skill_edits.go           | 25 +++++++++++
 2 files changed, 76 insertions(+)
 create mode 100644 internal/library/shared_edit_take_test.go

diff --git a/internal/library/shared_edit_take_test.go b/internal/library/shared_edit_take_test.go
new file mode 100644
index 000000000..4fc203732
--- /dev/null
+++ b/internal/library/shared_edit_take_test.go
@@ -0,0 +1,51 @@
+package library
+
+import (
+	"os"
+	"path/filepath"
+	"testing"
+	"time"
+)
+
+// An edit made in the shared copy — ~/.agents/skills where no link could
+// be made (Windows without the right to) — is taken into the library as
+// one in an agent's copy is, before the copy is replaced or set aside
+// (#4958): syncShared finds the stale copy only after takeEdits has had
+// its say.
+func TestEditInSharedCopyTaken(t *testing.T) {
+	h := sandbox(t)
+	src := filepath.Join(h, "src/skills")
+	skill(t, filepath.Join(src, "pdf"), "pdf", "Read PDFs")
+	shared := filepath.Join(h, ".agents/skills")
+	pdf := filepath.Join(shared, "pdf")
+	lib := filepath.Join(src, "pdf")
+
+	ok(t)(InstallSkills(src, []string{"pdf"}, []string{"claude"}))
+	ok(t)(SetSkillsWhere(SkillsInShared))
+	if !linked(pdf) {
+		t.Fatal("pdf isn't a link in ~/.agents/skills")
+	}
+	// where no link could be made, the entry is a marked copy instead:
+	// what copyIn puts in a link's place
+	if err := copyIn(pdf, "pdf"); err != nil {
+		t.Fatal(err)
+	}
+	if linked(pdf) || !ours(pdf, "pdf") {
+		t.Fatal("pdf isn't magpie's marked copy")
+	}
+	time.Sleep(20 * time.Millisecond)
+	write(t, filepath.Join(pdf, "notes.md"), "my notes\n")
+
+	ok(t)(Sync())
+	if read(t, filepath.Join(lib, "notes.md")) != "my notes\n" {
+		t.Error("the edit in the shared copy wasn't taken into the library")
+	}
+	// the entry is still magpie's, saying the library's skill: taken or
+	// relinked, the edit is not only in the backups
+	if !ours(pdf, "pdf") {
+		t.Fatal("the shared entry is no longer magpie's")
+	}
+	if _, err := os.Stat(filepath.Join(pdf, "notes.md")); err != nil {
+		t.Error("the shared entry lost the edit")
+	}
+}
diff --git a/internal/library/skill_edits.go b/internal/library/skill_edits.go
index b7c778e68..a8596b263 100644
--- a/internal/library/skill_edits.go
+++ b/internal/library/skill_edits.go
@@ -73,6 +73,31 @@ func (l *Library) takeEdits(targets []*Target, res *Result) {
 			}
 			edits = append(edits, edit{t.Agent.ID, p, at})
 		}
+		// the shared copy too (#4958): an edit made in ~/.agents/skills,
+		// where no link could be made (Windows without the right to), is
+		// the library's to take as one in an agent's copy is — before
+		// syncShared sets the stale copy aside. An agent whose own folder
+		// that is has had its copy read above.
+		if !seen[realDir(sharedSkillsDir())] {
+			p := filepath.Join(sharedSkillsDir(), s.Name)
+			if ours(p, s.Name) && !linked(p) {
+				made, ok := copiedAt(p)
+				if ok {
+					at, err := changedAt(p)
+					switch {
+					case err != nil:
+						failed("agents", s.Name, p, err)
+					case !at.After(made):
+						if l.untouched == nil {
+							l.untouched = map[string]bool{}
+						}
+						l.untouched[p] = true
+					case !sameTree(p, lib):
+						edits = append(edits, edit{"agents", p, at})
+					}
+				}
+			}
+		}
 		if len(edits) == 0 {
 			continue
 		}
-- 
2.50.1 (Apple Git-155)
```

</details>
