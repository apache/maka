Verified @Dopetaiga's fix (7648493c8 on [their fork](https://github.com/Dopetaiga/magpie/tree/fix/codex-own-catalog-slash-path)) on current main (`d0a4e0be6`): it applies as is, the diff is exactly the shape @laweit-lxy traced in the issue body, and the full `internal/agent` suite shows no new failures. Posting a verification of their commit rather than a competing patch — the commit below is Dopetaiga's unchanged, replayed on main.

**Why the fix is right** (checked branch by branch against the old one-liner):

- WSL (`at.spell != nil`): old returned false through the `at.spell == nil` conjunct; new returns false early. Same.
- Relative `c`: `filepath.Join(dir, c)` then `Clean` both sides, as before. Same.
- Absolute `c` on non-Windows: unreachable with a match — an exact match is caught by the `c == at.native(catalogPath)` line above, and `Clean` on unix changes nothing, so different absolute paths still don't match. No behavior change.
- Absolute `c` spelled with `/` on Windows — the issue's case: old fed it through `filepath.Join(dir, c)`, which prefixes `dir` onto an absolute path, so the comparison could never hit; new skips the join and `filepath.Clean` turns the slashes into `\`, so it names the catalog. Fixed.

Beyond `Sync`'s mending, the same predicate gates the put-back (`codex.go:1657`), the keys list (`:732`) and the drift message "Codex's model_catalog_json is no longer magpie's list" (`:2205`) — so configs left by pre-`cd217c174` magpies (which wrote `/`-spelled absolute paths, per #816's history) also stop triggering false drift rows once this lands.

**Siblings**: `rg -n "model_catalog_json" internal/ --glob '*.go'` (non-test) → the only same-shape predicate is `deskCatalog` (`internal/agent/codex.go:435`), which compares raw strings the same way and also mishandles an absolute `/`-spelled `c`. Leaving it: it was born on 2026-10-27 (`add927e60`) *with* the base-name write convention already in place, so magpie never wrote a `/`-spelled absolute desktop path — there is no legacy population like #4785's, and a hand-written one is the only way to reach it. Worth a follow-up only if a real config shows up.

| Check | Result |
| --- | --- |
| `git am` on `d0a4e0be6` | applies; tree identical to the branch head (`e72a9d76d52fc286`) |
| `GOOS=windows go build/vet ./internal/agent/` | clean |
| `GOOS=linux go build -tags nogui ./internal/agent/` | clean |
| `go test ./internal/agent/ -run 'TestCodex.*Catalog|TestCodexSyncMendsGoneCatalog|TestCodexOwnCatalogGoneNotPutBack'` (macOS) | ok 3.416s |
| `go test ./internal/agent/ -count=1 -timeout 25m` (macOS) | only `TestMothX` fails — fails identically on the parent (`7199afbb6`) run alone; this host's known red (local proxy) |
| `gofmt -l internal/agent/` | clean |

The red lives only on Windows: on unix `filepath.ToSlash` is the native spelling, so `TestCodexSyncMendsGoneCatalog/not_the_provider` cannot see the bug — the thread's real-machine runs are the red evidence (laweit-lxy on Windows 11 ARM64 at `8f804396fd`, Dopetaiga on Windows 11 x64 at `3e319622`, both `not_the_provider` FAIL, all green with the change). `2b22425b4`'s run sheet also lists #4785 among the failures yetone's own Windows 11 box sees at `origin/main`.

---
**Source**: reported in #4785 (split out of #4115's Windows test matrix) with the cause traced by the reporter; confirmed on a second machine and arch by Dopetaiga.

**Red without the fix**: not reproducible on my host (macOS; the failing predicate needs `runtime.GOOS == "windows"` — compile-time). The red is the thread's own data: `config.toml` still names `C:/Users/.../.codex/magpie-models.json` after Sync on Windows 11, both ARM64 and x64, at two main SHAs.

**Siblings**: `deskCatalog` left unchanged, reasons above. `mark.go:28` (`strings.Contains(value, "magpie")`) is spelling-agnostic. `import_codex.go` opens the path as Codex wrote it — no string comparison against magpie's own path.

**When the read fails**: an unreadable `config.toml` fails `GetTOMLTop` as before — untouched. `theirListGone` (a user's own list, file missing) still takes precedence in the put-back path (`:1657`), unchanged.

**Not verified**: a real Windows machine (my host is macOS); Codex's actual reload of a mended `config.toml` on Windows.

**Attribution**: verification written with GLM-5.3-Flash (ZCode); the commit is Dopetaiga's unchanged — please keep them as the author or add `Co-authored-by: Dopetaiga <dopetaiga@gmail.com>`. The root-cause analysis in the issue body is @laweit-lxy's, and the diff implements it as written.

**Branch with the commit**: [hunt-20261112-t1-4785](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-4785) (head `d349bc957ab14aaa`, on main `d0a4e0be6`).

**Patch**: <details><summary>patch: agent: ownCatalog cleans an absolute /-spelled catalog path on Windows (#4785) — git am applies it as is; SHA-256 first 16: 371fc9c249e9f450</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Dopetaiga <dopetaiga@gmail.com>
Date: Tue, 3 Nov 2026 14:59:50 +0800
Subject: [PATCH] agent: ownCatalog cleans an absolute /-spelled catalog path
 on Windows (#4785)

A config.toml naming the catalog with an absolute /-spelled path was
not recognised as magpie's own: the raw string matched neither the
base-name ref nor the \ spelling, so Sync left the key in and Codex
could not load its config once the list was gone. Clean the absolute
path too; on Windows that turns its slashes into the native ones.
The WSL spelling keeps its own branch.
---
 internal/agent/codex.go | 10 +++++++++-
 1 file changed, 9 insertions(+), 1 deletion(-)

diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index f923feed3..833887104 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -294,7 +294,15 @@ func codexIn(at place) *Agent {
 		if c == catalogRef || c == at.native(catalogPath) {
 			return true
 		}
-		return at.spell == nil && !filepath.IsAbs(c) && filepath.Clean(filepath.Join(dir, c)) == filepath.Clean(catalogPath)
+		if at.spell != nil {
+			return false
+		}
+		// an absolute c spelled with / on Windows: Clean turns its slashes
+		// into \, so it still names the catalog there (#4785)
+		if !filepath.IsAbs(c) {
+			c = filepath.Join(dir, c)
+		}
+		return filepath.Clean(c) == filepath.Clean(catalogPath)
 	}
 	// ownList is magpie's model list for Codex as written to catalogPath:
 	// what the user added by hand to the list there (a key magpie doesn't
-- 
2.50.1 (Apple Git-155)


```

</details>

