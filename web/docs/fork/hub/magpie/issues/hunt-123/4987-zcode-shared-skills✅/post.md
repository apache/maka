**What's wrong**

ZCode reads `~/.agents/skills` beside its own `~/.zcode/skills`, but it wasn't among the readers of the shared folder (`readsShared` in `internal/library/targets.go`): a skill kept there behaved as if ZCode didn't have it — its chip unlocked, and ticking it wrote a second link into `~/.zcode/skills`, the skill twice on disk.

**The fix** (one word in the list, the comment beside it, and the test)

`"zcode"` joins `readsShared`, so the shared copy answers for it: the chip is locked like Codex's or Gemini's, and no second link lands in its own folder — on a tick or on a sync.

**Verification**

| Check | Result |
| --- | --- |
| New `TestSharedSkillReachesZCode` (the shared skill imported, then given to zcode, then a sync) | red on the parent: `zcode has a second link to it in its own folder` and `zcode's own folder got it on the sync too`; ok with the fix — no link, the shared copy answers |
| Neighbors (`TestSharedSkillsWrittenOnce`, `TestImportSharedSkillForKimi`, `-count=1` full `go test -tags nogui ./internal/library/`) | ok (81.2s) |
| `-race` on the shared-skill tests | ok |
| `gofmt -l`, `go vet ./internal/library/`, `go build ./...` | clean / clean (the trayimage cgo warning is #4821's, as on main) / ok |

<details><summary>patch: library: ZCode reads the shared skills folder too (#4987) — git am applies it as is; SHA-256 first 16: c53276de6b60c4b5</summary>

```patch
From 760fd169bed62743765e75ae3340edaed6e10c20 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 4 Nov 2026 03:41:27 +0800
Subject: [PATCH] library: ZCode reads the shared skills folder too (#4987)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

ZCode reads ~/.agents/skills beside its own ~/.zcode/skills, but it
wasn't among the readers of the shared folder: a skill kept there
behaved as if ZCode didn't have it — its chip unlocked, a tick writing
a second link into its own folder. It reads it as the others do.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/library/agent_skills_test.go | 23 +++++++++++++++++++++++
 internal/library/targets.go           |  4 ++--
 2 files changed, 25 insertions(+), 2 deletions(-)

diff --git a/internal/library/agent_skills_test.go b/internal/library/agent_skills_test.go
index 387970090..90e5765b8 100644
--- a/internal/library/agent_skills_test.go
+++ b/internal/library/agent_skills_test.go
@@ -456,3 +456,26 @@ func TestPiInstructionsFirstThere(t *testing.T) {
 		t.Fatalf("AGENTS.md comes before CLAUDE.md: %q", tg.Instructions)
 	}
 }
+
+// A skill kept in ~/.agents/skills reaches ZCode, which reads that folder
+// beside its own ~/.zcode/skills: giving it to zcode ticks the chip the
+// shared copy already answers, and no second link lands in its own folder
+// (#4987).
+func TestSharedSkillReachesZCode(t *testing.T) {
+	h := sandbox(t)
+	write(t, filepath.Join(h, ".zcode/cli/config.json"), "")
+	write(t, filepath.Join(h, ".zcode/v2/config.json"), "{}")
+	shared := filepath.Join(h, ".agents/skills/orca")
+	skill(t, shared, "orca", "Orca")
+	ok(t)(ImportSkill("orca"))
+	own := filepath.Join(h, ".zcode/skills/orca")
+
+	ok(t)(SkillAgents("orca", []string{"kimi", "zcode"}))
+	if _, err := os.Lstat(own); !os.IsNotExist(err) {
+		t.Error("zcode has a second link to it in its own folder")
+	}
+	ok(t)(Sync())
+	if _, err := os.Lstat(own); !os.IsNotExist(err) {
+		t.Error("zcode's own folder got it on the sync too")
+	}
+}
diff --git a/internal/library/targets.go b/internal/library/targets.go
index 85a674280..705101b4c 100644
--- a/internal/library/targets.go
+++ b/internal/library/targets.go
@@ -952,8 +952,8 @@ func (l *Library) held(have []*Target) []*Target {
 // ~/.kimi-code/skills besides it (#4379). OmO's engine, senpi, a fork of
 // Pi from after Pi 0.54 (its oldest on npm is 0.74.0), reads it as Pi
 // does (core/package-manager.js, userAgentsSkillsDir, @code-yeongyu/senpi
-// 2026.5.13).
-var readsShared = []string{"codex", "gemini", "opencode", "deveco", "crush", "dsh", "commandcode", "devin", "droid", "cline", "grok", "grok-app", "fx", "alma", "kimi", "omo"}
+// 2026.5.13). ZCode reads it beside ~/.zcode/skills (#4987).
+var readsShared = []string{"codex", "gemini", "opencode", "deveco", "crush", "dsh", "commandcode", "devin", "droid", "cline", "grok", "grok-app", "fx", "alma", "kimi", "omo", "zcode"}
 
 // Pi reads ~/.agents/skills from 0.54.0 (2026-02-19, its CHANGELOG: "Added
 // default skill auto-discovery for .agents/skills locations … global
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [fix/4987-zcode-shared-skills](https://github.com/ggbdpq/magpie/tree/fix/4987-zcode-shared-skills) (head `760fd169bed62743765e75ae3340edaed6e10c20`).

**Not verified:** against a real ZCode install of more than one version — the shared-folder reading is the reporter's own and this machine's current ZCode's; if some ZCode version predates it, the entry belongs in `SharedToo` with a `sharedSince` gate instead, a one-line move for whoever knows the version.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode); I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
