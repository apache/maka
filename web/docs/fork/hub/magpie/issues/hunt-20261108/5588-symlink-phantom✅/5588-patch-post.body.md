@xqh-jason The symlinked-skill hand-over you reproduced (shared entry deleted, then a failure, then an unlisted folder in the library's skills folder that `hand-back` and `skill rm` both refuse) is fixed: the entry the sweep was eating was not a stray, and hand-over now refuses before it touches anything when there is no entry to hand over. Thanks for the exact control table — the Goose-present/symlink cell was the whole bug.

**Root cause**: `importSkill`'s stray-link sweep (`internal/library/skills.go:2513` at 46b10af87) removes every agent's link to the folder it brings in. Goose, Kimi Code and Cindy have the shared `~/.agents/skills` as their *own* skills folder, so their entry in that sweep is `~/.agents/skills/<name>` — the user's entry `handOver` reads at `skill_handover.go:108` and removes itself later. For a symlinked entry `linked(p)` is true, so the sweep took it; `sharedEntry` then found nothing and `handOver` failed after `importSkill` had already made the library's link. `library.json` is written on success only, so the link stayed unlisted — the phantom. A real folder never hit it (`linked(p)` is false for one), and neither did the same symlink where no such agent is detected — exactly your four control cells.

**The fix**: following your own analysis — the sweep now skips the agent whose skills folder is the shared one (`realDir(t.Skills) == realDir(sharedSkillsDir())`, the same test `readsSharedHere` and the stray-links loop in `handOver` already use), leaving that entry to hand-over, which removes it after the library's link stands. And as the safety net you asked for, `handOver` checks the entry before importing, so an unusable state is refused before anything is deleted. End state for your reproduction: hand-over succeeds, the folder elsewhere is untouched, the library links to it and lists it, and Goose's entry becomes magpie's own link to the library — the same end state a real folder in the shared root already had.

<details><summary>patch: library: hand-over of a symlinked skill no longer takes the shared entry before hand-over can (#5588) — git am applies it as is; SHA-256 first 16: f4af3976b7548bab</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 02:46:46 +0800
Subject: [PATCH] library: hand-over of a symlinked skill no longer takes the
 shared entry before hand-over can (#5588)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

importSkill's stray-link sweep took every agent's link to the folder
it was bringing in. For an agent whose own skills folder is the
shared one (Goose, Kimi Code, Cindy) that "link" is the user's entry
in ~/.agents/skills — the very entry handOver reads and then removes
itself. With such an agent here, a symlinked skill handed over
directly from the shared folder failed at the entry check after the
import: the shared entry was gone, the library's link stayed in its
folder unlisted (library.json is written on success only), and
hand-back and skill rm both answered no (xqh-jason, #5588). A real
folder was safe — linked(p) is false for one — and so was the same
symlink with no such agent.

The sweep now skips the agent whose folder is the shared one: its
entry is hand-over's to take, which it does after the library's link
stands. handOver also checks the entry before importing, so an
unusable state is refused before anything is touched.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/skill_handover.go      |  6 +++++
 internal/library/skill_handover_test.go | 33 +++++++++++++++++++++++++
 internal/library/skills.go              | 20 +++++++++------
 3 files changed, 52 insertions(+), 7 deletions(-)

diff --git a/internal/library/skill_handover.go b/internal/library/skill_handover.go
index 66a2bd3ad..ad4bf8f1e 100644
--- a/internal/library/skill_handover.go
+++ b/internal/library/skill_handover.go
@@ -100,6 +100,12 @@ func handOver(l *Library, found *[]FoundSkill, ts []*Target, name string) (left
 		if i < 0 || (*found)[i].Shared == "" && !within((*found)[i].real, sh) {
 			return "", fmt.Errorf("no skill called %s in %s", name, sharedSkillsDir())
 		}
+		// the entry is checked before anything is touched: importing first
+		// makes the library's link and takes the agents' stray links, and
+		// only then finding no entry to take would leave all that (#5588)
+		if _, err := os.Lstat(filepath.Join(sharedSkillsDir(), name)); err != nil {
+			return "", fmt.Errorf("%s isn't kept in %s", name, sharedSkillsDir())
+		}
 		if err := importSkill(l, *found, name); err != nil {
 			return "", err
 		}
diff --git a/internal/library/skill_handover_test.go b/internal/library/skill_handover_test.go
index 364616ea2..2377b2997 100644
--- a/internal/library/skill_handover_test.go
+++ b/internal/library/skill_handover_test.go
@@ -233,6 +233,39 @@ func TestHandOverWithGoose(t *testing.T) {
 	}
 }
 
+// A symlink in ~/.agents/skills handed over while an agent whose own
+// folder is the shared one (Goose) is here (xqh-jason, #5588): the
+// import's stray-link sweep used to take the shared entry itself — for
+// such an agent that entry is not a stray, it is the entry hand-over is
+// there to take — and hand-over then found no entry and failed, after the
+// library's link was made: a folder the library didn't list was left in
+// its folder, the agents' entry was gone, and no CLI way back. Now the
+// sweep leaves the shared entry alone and hand-over succeeds.
+func TestHandOverSharedLinkWithGoose(t *testing.T) {
+	h := sandbox(t)
+	shared := filepath.Join(h, ".agents/skills")
+	ext := filepath.Join(h, "aimer-skills/grilling")
+	skill(t, ext, "grilling", "Grill")
+	symlink(t, ext, filepath.Join(shared, "grilling"))
+	ok(t)(HandOverSkills([]string{"grilling"}))
+	if read(t, filepath.Join(ext, "SKILL.md")) == "" {
+		t.Fatal("the folder elsewhere went")
+	}
+	lib := skillDir("grilling")
+	if !linked(lib) || realDir(lib) != realDir(ext) {
+		t.Fatal("the library doesn't link to the folder")
+	}
+	// the entry is the library's now, as goose's own link to it (the
+	// user's link to the folder elsewhere was taken)
+	if !ours(filepath.Join(shared, "grilling"), "grilling") {
+		t.Fatal("goose's entry in ~/.agents/skills isn't the library's")
+	}
+	v := offView(t, "grilling")
+	if v.Shared != "" || v.Kind != "folder" || realDir(v.Source) != realDir(ext) || !slices.Contains(v.Agents, "goose") {
+		t.Errorf("after: %+v", v)
+	}
+}
+
 // A skill kept in ~/.agents/skills under another folder's name is still
 // the shared folder's: Goose, whose folder that is, isn't given a second
 // one beside it, and handed over, the folder moves in by the skill's name.
diff --git a/internal/library/skills.go b/internal/library/skills.go
index 3d26627da..5407339d5 100644
--- a/internal/library/skills.go
+++ b/internal/library/skills.go
@@ -2511,13 +2511,19 @@ func importSkill(l *Library, found []FoundSkill, name string) error {
 		src = nil
 	}
 	for _, id := range f.Agents { // links to what was moved, or to the folder elsewhere
-		if t := targetByID(id); t != nil {
-			p := filepath.Join(t.Skills, name)
-			if linked(p) {
-				os.Remove(p)
-			} else if _, err := os.Lstat(p); err == nil && src == nil && realDir(p) != realDir(skillDir(name)) {
-				setAside(id, p)
-			}
+		t := targetByID(id)
+		// the agent whose own folder is the shared one (Goose, Kimi Code,
+		// Cindy) keeps the entry hand-over is there to take, not a stray
+		// of its own (#5588): taking it here would fail hand-over after
+		// the library's link was made, leaving an entry it doesn't list
+		if t == nil || realDir(t.Skills) == realDir(sharedSkillsDir()) {
+			continue
+		}
+		p := filepath.Join(t.Skills, name)
+		if linked(p) {
+			os.Remove(p)
+		} else if _, err := os.Lstat(p); err == nil && src == nil && realDir(p) != realDir(skillDir(name)) {
+			setAside(id, p)
 		}
 	}
 	// an agent with a copy of the very same gets the library's in its
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5588-symlink-skill-phantom`](https://github.com/ggbdpq/magpie/tree/fix/5588-symlink-skill-phantom) (head `e7d47e1aa9072905c4203378f6dc733a0fd6ef4e`), rebased onto current `upstream/main` (d32a7a70c); on a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestHandOverSharedLinkWithGoose` (new) | red before the fix with the reported error ("grilling isn't kept in …/.agents/skills"), pass after |
| hand-over neighbours: `TestHandOverSharedFolder`, `TestHandOverSharedLink`, `TestHandOverFound`, `TestHandOverWithGoose`, `TestSharedUnderAnotherName`, `TestHandOverFailureKeepsOriginal` | pass |
| `go test ./internal/library/ -tags nogui -timeout 25m -count=1` | ok (188s), zero failures |
| `go test -tags nogui ./...` (count=1, 25m cap) | 83 packages ok; 5 fail — `TestMothX`, `TestProxyCheckSaysAProxyPassedBy`, `TestHostToldTheGatewayAddress` (long-known reds on this machine) and `TestSettingsCLISetsWhatTheWindowSaves`, `TestSettingsSaveKeepsWhatItDoesNotSend`; the last two fail the same on a Go-identical `upstream/main` checkout on this machine, so they are this machine's, not this patch's — not counted as pass |
| targeted `-race` (`go test -race ./internal/library/ -run TestHandOver`) | pass |
| `gofmt -l <changed files>` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui`; `GOOS=windows go build` | clean |
| Ablation | reverting the two product files (the sweep skip and the pre-import entry check) turns `TestHandOverSharedLinkWithGoose` red again with the reported error; restored, green |
| Re-verified on upstream/main `d32a7a70c` | rebased onto it; `go test ./internal/library/` re-run green at the new head (98s) |

**Not verified**: Windows (NOT-RUNNABLE here — the new test skips where symlinks can't be made, and junction behaviour differs); WSL; and your real-HOME library (66 of 87 symlinks) — recovering the phantoms a past run left, if any, is still by hand under `~/.config/magpie/library/skills/`, since the library never recorded them; the patch only stops new ones.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
