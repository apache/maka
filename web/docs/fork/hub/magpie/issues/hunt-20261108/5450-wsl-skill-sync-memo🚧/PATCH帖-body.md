@yetone `magpie library sync` on Windows 11 with "Detect agents in WSL" on took 82.5 s and still ended "every agent already has it" (@Doeye1997). Their own goroutine dump sat in `os.Lstat` on `\\wsl.localhost\Ubuntu\home` under `syncSkills`, their CPU profile sat in `library.readView`, `statPart`, `lookPart`, `ours` and `linkTarget`, and their metadata table put one look on a `\\wsl.localhost` path at about 44x one on `C:\` — so the fix follows the reporter's own analysis: look at each WSL ancestor once per step instead of once per skill.

**Root cause**: `resolve` walks a path a part at a time through `lookPart`, and the Library page's read holds a memo of what each part turned out to be (`internal/library/linkmemo.go`, `readParts`, #1771), so a read looks at each folder once. Nothing in the sync held that memo. Every `realDir` in `syncSkills` (`internal/library/skills.go`) — the ownership checks, the sharer detection, the library side of each comparison — therefore re-walked the whole tree down to the skills folder, one look per part: the same few ancestors once per skill per agent, on `\\wsl.localhost` at 44x the price.

**The fix**: each agent's skill step now holds the read's memo while it runs and lets it go before LiveAgent's picks are read, so the ancestors are looked at once for the step and every later reader — a sharer of the same folder, the next step, the page's next read — still sees what the step wrote. The step holds `mu` as the read does, so nothing that writes can run under its memo; a caller without `mu` (a probe of a folder to add) gets what `linkmemo.go` already says it gets, at most as old as the step's last look. Steps outside the skill step (finding the targets, building the step list) walk each agent's tree once per sync, not once per skill, and are left as they are. On the test sandbox one agent's step on 32 skills went from 631 looks at its own folder's ancestors to 33 — what discovery and the step list make once per agent — and the whole test sync's looks fell from 56,909 to 6,802; the remainder is once per skill on cheap local paths (the library's own side, and the leaf looks), the `C:\` column of the reporter's table.

<details><summary>patch: library: an agent's skill step of a sync reads its tree the way a read of the page does (#5450) — git am applies it as is; SHA-256 first 16: 16e7ee4e866ec2d4</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 13:10:54 +0800
Subject: [PATCH] library: an agent's skill step of a sync reads its tree the
 way a read of the page does (#5450)

A sync of the library walked the tree down to each agent's skills
folder once per skill: every realDir of every skill resolved the same
path, a look a part, and nothing held the memo a read of the page
holds (linkmemo.go), so each part was looked at again. On Windows with
WSL detection on that tree is a \\wsl.localhost path, one look on
which costs many of a local one (44x on the reporter's machine), and a
folder of many skills took a minute-plus to sync although nothing had
changed (82s, Doeye1997): the goroutine dump sat in os.Lstat on
\\wsl.localhost\\Ubuntu\\home under syncSkills.

Each agent's skill step now holds the memo while it runs, and lets it
go before LiveAgent's picks are read, so the ancestors are looked at
once for the step and every later reader (a sharer of the folder, the
next step, the page) still sees what the step wrote. The step holds mu
as the read does, so nothing that writes can run under its memo; a
caller without mu (a probe of a folder to add) gets what it says it
gets: at most as old as the step's last look.

One agent's step on 32 skills went from 631 looks at its own folder's
ancestors to 33, what finding the targets and building the steps make
once per agent; the whole test sync's looks fell from 56,909 to 6,802,
what the steps outside the skill step read once per skill on cheap
local paths.

TestSyncSkillsLooksAtAncestorsOnce
---
 internal/library/linkmemo.go              |  9 ++-
 internal/library/skills.go                | 16 +++-
 internal/library/sync_skills_memo_test.go | 98 +++++++++++++++++++++++
 3 files changed, 117 insertions(+), 6 deletions(-)
 create mode 100644 internal/library/sync_skills_memo_test.go

diff --git a/internal/library/linkmemo.go b/internal/library/linkmemo.go
index 1edc9ed4e..0b543b964 100644
--- a/internal/library/linkmemo.go
+++ b/internal/library/linkmemo.go
@@ -38,10 +38,11 @@ type partMemo struct {
 var reading atomic.Pointer[partMemo]
 
 // readParts keeps what lookPart finds until the returned func is called.
-// Only a read of the page that holds mu calls it: no change can make or
-// take away a link while it does, since every change holds mu too. A
-// caller without mu meanwhile (a probe of a folder to add) is given what
-// the read found, at most as old as the read.
+// Only a holder of mu calls it: a read of the page, and each agent's
+// skill step of a sync (#5450). No change can make or take away a link
+// while it does, since every change holds mu too. A caller without mu
+// meanwhile (a probe of a folder to add) is given what the holder found,
+// at most as old as its last look.
 func readParts() (done func()) {
 	reading.Store(&partMemo{m: map[string]part{}})
 	return func() { reading.Store(nil) }
diff --git a/internal/library/skills.go b/internal/library/skills.go
index 3d26627da..e3d5ed970 100644
--- a/internal/library/skills.go
+++ b/internal/library/skills.go
@@ -677,8 +677,20 @@ func (l *Library) syncSkills(t *Target, res *Result, all []*Target) {
 		return
 	}
 	id := t.Agent.ID
-	// LiveAgent uses a skill in its folder only once it is picked there
-	defer l.syncLiveAgentPicks(t, res)
+	// each folder on the way to a skill is looked at once for this agent,
+	// as a read of the page is (linkmemo.go): every realDir of every skill
+	// walks the same tree down to its folder, and on Windows with a WSL
+	// distro that tree is a \\wsl.localhost path, where one look costs many
+	// of a local one (#5450, Doeye1997). The memo dies with the call, so
+	// what a sharer of this folder, a later step or the page's next read
+	// sees is never older than what this step wrote.
+	forget := readParts()
+	// LiveAgent uses a skill in its folder only once it is picked there;
+	// what it reads is read after the memo is let go
+	defer func() {
+		forget()
+		l.syncLiveAgentPicks(t, res)
+	}()
 	a := l.applied(id)
 	// another agent may read the very same folder (one linked to the other):
 	// what that agent is to have stays
diff --git a/internal/library/sync_skills_memo_test.go b/internal/library/sync_skills_memo_test.go
new file mode 100644
index 000000000..d68cea73e
--- /dev/null
+++ b/internal/library/sync_skills_memo_test.go
@@ -0,0 +1,98 @@
+package library
+
+import (
+	"fmt"
+	"os"
+	"path/filepath"
+	"slices"
+	"sync/atomic"
+	"testing"
+)
+
+// Every realDir of every skill walks the same tree down to the agent's
+// skills folder. With WSL detection on, that tree is a \\wsl.localhost
+// path, where one look costs many of a local one (#5450): a sync stat'd
+// the ancestors once per skill, and a folder of many skills took a
+// minute-plus. Each agent's skill step now holds the page read's memo
+// (linkmemo.go), so the ancestors are looked at once for the step, not
+// once per skill.
+func TestSyncSkillsLooksAtAncestorsOnce(t *testing.T) {
+	sandbox(t)
+	src := filepath.Join(t.TempDir(), "src")
+	var names []string
+	for i := range 32 {
+		names = append(names, fmt.Sprintf("skill-%02d", i))
+		write(t, filepath.Join(src, names[i], "SKILL.md"), "---\nname: "+names[i]+"\ndescription: a fixture\n---\nbody\n")
+	}
+	var ids, dirs []string
+	for _, tg := range Targets() {
+		ids = append(ids, tg.Agent.ID)
+		if tg.Skills != "" && !slices.Contains(dirs, tg.Skills) {
+			dirs = append(dirs, tg.Skills)
+		}
+	}
+	ok(t)(InstallSkills(src, names, ids))
+
+	home := os.Getenv("HOME")
+	// the walks follow /var and kin through to where they point, so the
+	// parts looked at are the resolved tree's
+	if r, err := filepath.EvalSymlinks(home); err == nil {
+		home = r
+	}
+	claudeSkills := filepath.Join(home, ".claude", "skills")
+	if _, err := os.Stat(claudeSkills); err != nil {
+		t.Fatalf("claude's skills folder: %v", err)
+	}
+	// the looks of the tree down to claude's skills folder, excluding the
+	// skills themselves: the part every skill's walk repeats. A few walks
+	// a sync makes once per agent (finding the targets, building the
+	// steps); the storm is one walk per skill, so the bound is a few per
+	// agent, far under one per skill.
+	bound := int64(4*len(ids) + 8)
+	var ancestorLooks atomic.Int64
+	look := lookAt
+	t.Cleanup(func() { lookAt = look })
+	lookAt = func(p string) (part, bool) {
+		if p == filepath.Join(home, ".claude") || p == claudeSkills {
+			ancestorLooks.Add(1)
+		}
+		return look(p)
+	}
+
+	// a sync that gives the skills back: claude's folder is emptied first
+	for _, n := range names {
+		if err := os.RemoveAll(filepath.Join(claudeSkills, n)); err != nil {
+			t.Fatal(err)
+		}
+	}
+	ancestorLooks.Store(0)
+	first, err := Sync()
+	if err != nil {
+		t.Fatal(err)
+	}
+	if n := ancestorLooks.Load(); n > bound {
+		t.Errorf("the first sync looked at claude's ancestors %d times for %d skills (%d agents, bound %d); want a few per agent, not one walk per skill", n, len(names), len(ids), bound)
+	}
+	for _, n := range names {
+		if _, err := os.Lstat(filepath.Join(claudeSkills, n)); err != nil {
+			t.Fatalf("claude's %s after the sync: %v", n, err)
+		}
+	}
+
+	// the sync again, nothing to change ("every agent already has it",
+	// the report's own case): the same few looks, and nothing changed
+	ancestorLooks.Store(0)
+	second, err := Sync()
+	if err != nil {
+		t.Fatal(err)
+	}
+	if n := ancestorLooks.Load(); n > bound {
+		t.Errorf("the second sync looked at claude's ancestors %d times for %d skills (%d agents, bound %d); want a few per agent, not one walk per skill", n, len(names), len(ids), bound)
+	}
+	if len(second.Changed) != 0 {
+		t.Errorf("the second sync changed %v; want every agent already had it", second.Changed)
+	}
+	if len(first.Problems) > 0 || len(second.Problems) > 0 {
+		t.Fatalf("problems: %+v %+v", first.Problems, second.Problems)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5450-wsl-sync-skill-memo`](https://github.com/ggbdpq/magpie/tree/fix/5450-wsl-sync-skill-memo) (head `e375f4c8a8a817c69fffa24709ed24f36ed53a31`), rebased onto current `upstream/main` (`691a10446`); on a fresh checkout `git am` applies clean (the tree `f5ca67bb76e76787a6fd477ff169d1cb31eddd3d` reproduces byte for byte).

| Check | Result |
| --- | --- |
| `TestSyncSkillsLooksAtAncestorsOnce` (new) | red before the fix (631 and 567 ancestor looks per sync), green after (33 and 33, bound 56) |
| `go test ./internal/library/ -tags nogui -timeout 25m -count=1` | ok (264 s), zero failures |
| `go test -tags nogui ./...` | not run — the change is confined to internal/library, whose whole package passes |
| targeted `-race` (`TestSync*`, `TestRead*`, `TestGlance*`, `TestTake*`, `TestShared*`, `TestSkill*`, `-tags nogui -race`) | pass |
| `gofmt -l internal/library` | prints nothing |
| `go vet ./internal/library/` | clean |
| `go build` (darwin/arm64), `GOOS=windows go build ./...` | clean |
| `GOOS=linux go build ./...` | fails inside wails v3.0.0-beta.24 itself (`undefined: pointer`, `menu_linux.go`) on this toolchain; the commit is pure Go in `internal/library` and out of it — fails the same on origin/main, so it is not a baseline |
| Ablation | removing the `readParts` hold in `syncSkills` turns `TestSyncSkillsLooksAtAncestorsOnce` red (567 ancestor looks); restored, green |
| Re-verified on upstream/main | rebased from `eef99e4bb` to `691a10446` (three provider/native commits between, none touching internal/library); the targeted tests re-ran green after the rebase |

**Not verified**: the 82 s repro itself on real Windows 11 with a real WSL distro — NOT-RUNNABLE here (darwin). The ~44x per-look figure is the reporter's own measurement; the test asserts the same shape it multiplies (looks per sync) on plain local paths.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
