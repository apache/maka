A skill given to the new Kimi Code (2.x) goes into a folder of its own now, so it reaches Kimi Code alone.

**What happens**: a skill ticked for Kimi Code had nowhere to go but `~/.agents/skills`, which fourteen other agents read as well (codex, gemini, opencode, deveco, crush, dsh, commandcode, devin, droid, cline, grok, grok-app, fx, alma), so it reached every one of them whatever the library ticks — and the page locked their chips for it. Handing the skill over to the library didn't isolate it either: Kimi Code's own link was still written into the shared folder, and unticking the other agents left it there, since none of the agents whose folder the shared one is had given the skill.

**Why**: Kimi Code 2.x reads a folder of its own besides the shared one — `$KIMI_CODE_HOME/skills/`, else `~/.kimi-code/skills/` (its docs, `docs/en/customization/skills.md`, "Skill Locations") — but magpie's target for it was the shared folder alone. The legacy kimi-cli branch keeps the shared folder: it reads the first of `~/.kimi/skills`, `~/.claude/skills`, `~/.codex/skills`, so a folder of its own would hide Claude Code's from it.

**The fix**: the 2.x branch targets `$KIMI_CODE_HOME/skills` (else `~/.kimi-code/skills`), and Kimi Code joins `readsShared` — a skill kept in `~/.agents/skills` for another agent is read where it is, with no second link in Kimi Code's own folder, as for codex and the rest. What an older magpie put in the shared folder for Kimi Code is swept out on the next sync: an entry of the library's own stays there only while an agent whose folder the shared one is (Goose, Cindy) still gives the skill; the user's own entries are never touched. Skills already given to Kimi Code move to its own folder on the next sync.

| Check | Command | Result |
| --- | --- | --- |
| New tests | `go test ./internal/library/ -run 'TestKimiCodeSkillsOwnFolder\|TestKimiOldSharedEntrySwept' -count=1 -v` | 2 pass |
| Package | `go test ./internal/library/ -count=1 -tags nogui` | ok 67.4s |
| Format | `gofmt -l internal/library/` | empty |
| Vet | `go vet ./internal/library/` (darwin, linux, windows) | clean |
| Build | `go build -tags nogui .` (darwin, linux, windows) | ok |

**Red without the fix** (base `de7953e3b`, product files reverted, new tests kept):
```
--- FAIL: TestKimiCodeSkillsOwnFolder (1.93s)
    kimi_skills_test.go:26: Kimi Code hasn't the skill in ~/.kimi-code/skills
    kimi_skills_test.go:29: the skill sits in ~/.agents/skills, which every reader reads
--- FAIL: TestKimiOldSharedEntrySwept (0.07s)
    kimi_skills_test.go:76: the shared entry of Kimi Code's own skill is still there
    kimi_skills_test.go:79: Kimi Code hasn't the skill in its own folder
```
With the fix: both pass. Sweep alone reverted leaves the second test red; targeting alone reverted leaves the first red.

**Siblings**: `rg -n "sharedSkillsDir\(" internal/` — Goose's and Cindy's targets, the legacy kimi-cli branch and the view and hand-over read paths are shared-folder semantics and stay as they were; a skill given to Goose or Cindy still lives in the shared folder, which Kimi Code reads where it is. Project skills are left alone on purpose: a project's `.agents/skills` is the repo-level folder those agents share by design, though Kimi Code 2.x reads a project's `.kimi-code/skills/` too — a separate face if project skills are to be isolated as well.

**Not verified**: a real Kimi Code 2.x install end to end (the tests drive the same folder detection the agent code uses, against a sandbox home, as the existing Kimi tests do).

**When the read fails**: a shared folder that can't be read is left as it is; an entry that can't be removed is said in the result's problems and stays; a copy takeEdits couldn't scan stays in place.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(library): give Kimi Code its own skills folder (#4379) — git am applies it as is; SHA-256 first 16: 845bbb17490ba573</summary>

````patch
From 02d804a5246d2947ef8198a118cd69d922e6f993 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 03:05:13 +0800
Subject: [PATCH] fix(library): give Kimi Code its own skills folder (#4379)

A skill given to the new Kimi Code (2.x) had no folder of its own to
go to: its target was ~/.agents/skills, which fourteen other agents
read as well, so it reached every one of them whatever the library
ticks, and the page locked their chips for it. Handing it over to the
library didn't isolate it either: Kimi Code's own link was written
into the shared folder all the same, and no sync took it out, since
none of the agents whose folder the shared one is had given the skill.

Kimi Code 2.x reads a folder of its own besides the shared one
($KIMI_CODE_HOME/skills, else ~/.kimi-code/skills - docs/
customization/skills.md, "Skill Locations"), so its skills go there
now, and it joins readsShared: a skill kept in ~/.agents/skills for
another agent is read where it is, with no second link in Kimi
Code's own folder. The legacy kimi-cli branch stays as it was: it
reads the first of ~/.kimi/skills, ~/.claude/skills, ~/.codex/skills,
so a folder of its own would hide Claude Code's from it.

What an older magpie put in ~/.agents/skills for Kimi Code is swept
out: an entry of the library's own stays there only while an agent
whose folder the shared one is still gives the skill. The user's own
entries stay, and so does a copy takeEdits couldn't scan.

Fixes #4379

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/kimi_skills_test.go | 84 ++++++++++++++++++++++++++++
 internal/library/skills.go           | 37 ++++++++++++
 internal/library/sync.go             |  1 +
 internal/library/targets.go          | 13 +++--
 4 files changed, 131 insertions(+), 4 deletions(-)
 create mode 100644 internal/library/kimi_skills_test.go

diff --git a/internal/library/kimi_skills_test.go b/internal/library/kimi_skills_test.go
new file mode 100644
index 000000000..4983c0190
--- /dev/null
+++ b/internal/library/kimi_skills_test.go
@@ -0,0 +1,84 @@
+package library
+
+import (
+	"os"
+	"path/filepath"
+	"testing"
+)
+
+// A skill given to the new Kimi Code (2.x) goes into its own folder
+// ($KIMI_CODE_HOME/skills, else ~/.kimi-code/skills — its docs,
+// MoonshotAI/kimi-code, docs/en/customization/skills.md "Skill
+// Locations"), not into ~/.agents/skills: one there reaches every agent
+// that reads that folder, whatever the library ticks (#4379). Kimi Code
+// reads the shared folder as well as its own, so a skill kept there for
+// another agent gets no second link of its own.
+func TestKimiCodeSkillsOwnFolder(t *testing.T) {
+	h := sandbox(t)
+	write(t, filepath.Join(h, ".kimi-code/config.toml"), "")
+	src := filepath.Join(h, "src/skills")
+	skill(t, filepath.Join(src, "pdf"), "pdf", "Read PDFs")
+	shared := filepath.Join(h, ".agents/skills/pdf")
+	own := filepath.Join(h, ".kimi-code/skills/pdf")
+
+	ok(t)(InstallSkills(src, []string{"pdf"}, []string{"kimi"}))
+	if !ours(own, "pdf") {
+		t.Error("Kimi Code hasn't the skill in ~/.kimi-code/skills")
+	}
+	if _, err := os.Lstat(shared); !os.IsNotExist(err) {
+		t.Error("the skill sits in ~/.agents/skills, which every reader reads")
+	}
+
+	// a skill Goose has too stays one entry in the shared folder, which
+	// Kimi Code reads where it is: no second link of it in Kimi Code's own
+	skill(t, filepath.Join(src, "orca"), "orca", "Orca")
+	ok(t)(InstallSkills(src, []string{"orca"}, []string{"goose", "kimi"}))
+	if !ours(filepath.Join(h, ".agents/skills/orca"), "orca") {
+		t.Error("goose hasn't its skill in ~/.agents/skills")
+	}
+	if _, err := os.Lstat(filepath.Join(h, ".kimi-code/skills/orca")); !os.IsNotExist(err) {
+		t.Error("Kimi Code has a second link to Goose's skill")
+	}
+}
+
+// A skill an older magpie put in ~/.agents/skills for Kimi Code is taken
+// out of there once it is Kimi Code's alone: the link left behind would go
+// on reaching every reader of the folder, whatever the library ticks
+// (#4379). One an agent whose folder the shared one is (Goose) still gives
+// stays.
+func TestKimiOldSharedEntrySwept(t *testing.T) {
+	h := sandbox(t)
+	write(t, filepath.Join(h, ".kimi-code/config.toml"), "")
+	src := filepath.Join(h, "src/skills")
+	skill(t, filepath.Join(src, "pdf"), "pdf", "Read PDFs")
+	shared := filepath.Join(h, ".agents/skills/pdf")
+	own := filepath.Join(h, ".kimi-code/skills/pdf")
+
+	ok(t)(InstallSkills(src, []string{"pdf"}, []string{"kimi"}))
+	// what a magpie before Kimi Code's own folder left in the shared one
+	if _, err := os.Lstat(shared); os.IsNotExist(err) {
+		if err := os.MkdirAll(filepath.Dir(shared), 0o755); err != nil {
+			t.Fatal(err)
+		}
+		if err := os.Symlink(skillDir("pdf"), shared); err != nil {
+			t.Fatal(err)
+		}
+	} else if err != nil {
+		t.Fatal(err)
+	}
+
+	// Goose's skill is delivered in the shared folder and stays there
+	skill(t, filepath.Join(src, "orca"), "orca", "Orca")
+	ok(t)(InstallSkills(src, []string{"orca"}, []string{"goose"}))
+	ok(t)(Sync())
+
+	if _, err := os.Lstat(shared); !os.IsNotExist(err) {
+		t.Error("the shared entry of Kimi Code's own skill is still there")
+	}
+	if !ours(own, "pdf") {
+		t.Error("Kimi Code hasn't the skill in its own folder")
+	}
+	if !ours(filepath.Join(h, ".agents/skills/orca"), "orca") {
+		t.Error("goose's skill went from ~/.agents/skills")
+	}
+}
diff --git a/internal/library/skills.go b/internal/library/skills.go
index 9a053f890..79c2cf117 100644
--- a/internal/library/skills.go
+++ b/internal/library/skills.go
@@ -713,6 +713,43 @@ func (l *Library) syncSkills(t *Target, res *Result, all []*Target) {
 	a.Skills = mine
 }
 
+// sweepShared takes magpie's own entries out of ~/.agents/skills once no
+// agent whose folder it is, or that still reads it for the skill, has it
+// any more: an entry put there for an agent that reads its own folder now
+// (Kimi Code, #4379) would go on reaching every reader of the folder,
+// whatever the library ticks.
+func (l *Library) sweepShared(all []*Target, res *Result) {
+	es, err := os.ReadDir(sharedSkillsDir())
+	if err != nil {
+		return
+	}
+	shared := realDir(sharedSkillsDir())
+	var holders []*Target
+	for _, o := range all {
+		if o.Skills != "" && realDir(o.Skills) == shared {
+			holders = append(holders, o)
+		}
+	}
+	for _, e := range es {
+		name := e.Name()
+		p := filepath.Join(sharedSkillsDir(), name)
+		// the user's own entries stay, and so does a copy takeEdits
+		// couldn't scan, held in place for its edits
+		if !ours(p, name) || l.blockedSkills[realDir(p)] {
+			continue
+		}
+		s := l.skill(name)
+		if slices.ContainsFunc(holders, func(o *Target) bool { return s.gives(o.Agent.ID) }) {
+			continue
+		}
+		if err := unlink(p); err != nil {
+			res.fail("agents", "skill:"+name, err)
+			continue
+		}
+		dropOld(p, name)
+	}
+}
+
 // ---- finding skills to install --------------------------------------------
 
 // Candidate is a skill found where the user pointed: in a repository, or
diff --git a/internal/library/sync.go b/internal/library/sync.go
index 9d89c3f6f..94c3221d4 100644
--- a/internal/library/sync.go
+++ b/internal/library/sync.go
@@ -119,6 +119,7 @@ func syncSteps(all, gone []*Target, b *backups, res *Result) []func(*Library) {
 	// ~/.agents/skills first: an agent that reads it too gets no second
 	// link to what is there already
 	shared := realDir(sharedSkillsDir())
+	steps = append(steps, func(l *Library) { l.sweepShared(append(slices.Clone(all), gone...), res) })
 	for _, first := range []bool{true, false} {
 		for _, t := range all {
 			switch {
diff --git a/internal/library/targets.go b/internal/library/targets.go
index 2f79b08ab..9b1218cbf 100644
--- a/internal/library/targets.go
+++ b/internal/library/targets.go
@@ -277,7 +277,11 @@ func targetOf(a *agent.Agent) *Target {
 		// its own would hide Claude Code's from it — and ~/.config/agents/
 		// skills, ~/.agents/skills (kimi_cli/skill), wherever KIMI_SHARE_DIR
 		// is; before its 1.x brand/generic split, only the first of all five.
-		// The new Kimi Code (2.x) reads its own and ~/.agents/skills only.
+		// The new Kimi Code (2.x) reads its own folder of skills
+		// ($KIMI_CODE_HOME/skills, else ~/.kimi-code/skills, docs/
+		// customization/skills.md "Skill Locations") and ~/.agents/skills:
+		// its skills go into its own, for one in the shared folder reaches
+		// every reader of it whatever the library ticks (#4379).
 		//
 		// Its MCP servers are the mcp.json in its folder, which the old
 		// kimi-cli (fastmcp's MCPConfig) and the new Kimi Code read alike.
@@ -288,7 +292,7 @@ func targetOf(a *agent.Agent) *Target {
 			// user-wide one (loadAgentsMdForRoots in packages/agent-core-v2/
 			// src/agent/profile/context.ts, MoonshotAI/kimi-code afd95f64)
 			t.Instructions = filepath.Join(a.Dir, "AGENTS.md")
-			t.Skills = sharedSkillsDir()
+			t.Skills = filepath.Join(a.Dir, "skills")
 		} else if d := filepath.Join(h, ".config", "agents", "skills"); isDir(d) {
 			t.Skills = d
 		} else {
@@ -928,8 +932,9 @@ func (l *Library) held(have []*Target) []*Target {
 }
 
 // readsShared are the agents that read ~/.agents/skills as well as their
-// own folder (each one's docs or source).
-var readsShared = []string{"codex", "gemini", "opencode", "deveco", "crush", "dsh", "commandcode", "devin", "droid", "cline", "grok", "grok-app", "fx", "alma"}
+// own folder (each one's docs or source): Kimi Code's own is
+// ~/.kimi-code/skills besides it (#4379).
+var readsShared = []string{"codex", "gemini", "opencode", "deveco", "crush", "dsh", "commandcode", "devin", "droid", "cline", "grok", "grok-app", "fx", "alma", "kimi"}
 
 // readsWith adds to each agent's SkillsAlso the agents whose folder it
 // reads skills from too: one that is the very same folder (Kimi Code's,
-- 
2.50.1 (Apple Git-155)
````

</details>

Branch with the commit: [fix/4379-kimi-skill-scope](https://github.com/ggbdpq/magpie/tree/fix/4379-kimi-skill-scope) (head `02d804a5246d2947ef8198a118cd69d922e6f993`).
