**Summary**
`TestDshSetEffortWritesALegacyEntryWithTheCatalog` died once, not in its body but at cleanup: on Windows, `t.TempDir`'s `RemoveAll` found `.config/magpie` "not empty" (LoKi's box — thanks for the report and the reruns, @lokic7123-star). The probe in the issue found no late writer and no goroutine left behind, and that fits: the folder is written synchronously inside the test. What is left is a Windows-only window, so the removal is now tried again for a moment before `t.TempDir`'s own cleanup gets its turn (#2982).

**Why it only shows on Windows**
`provider.Save` replaces `providers.json` whole, by renaming a file over the one that is there (`store`, `internal/provider/provider.go`). When a scanner (Defender, the indexer) holds the file that was just renamed over, its entry stays listed in the folder while it is pending deletion, so `.config/magpie` reads as "not empty" for as long as that handle is open — typically milliseconds. Go's `testing` cleanup retries an access-denied and a sharing violation but not an `ERROR_DIR_NOT_EMPTY`, so it gave up on the first try; by the next run the folder is genuinely empty again. That is why the test passed alone 20 times and in the full `^TestDsh` set 10 times, and why no probe could catch the folder non-empty from Go.

**What changed**
The seven dsh tests that set up a temp home repeated the same six lines (`t.TempDir`, then `HOME`/`USERPROFILE`/`DSH_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`). They now share `dshTempHome` (`internal/agent/dsh_test.go`), which does the same setup and, registered after `t.TempDir` (so it runs before `t.TempDir`'s own cleanup), tries the removal itself until the folder is really gone, for up to five seconds, 10 ms apart; once it succeeds, `t.TempDir`'s own `RemoveAll` is a no-op. If the wait is up and the folder is still there, the helper returns quietly and `t.TempDir`'s cleanup reports what it sees, as before — no worse.

**Verification**
| Check | Result |
| --- | --- |
| `go test -tags nogui -run TestDsh ./internal/agent -count=1` | ok (7/7), also 4.3 s on the clean am'd tree |
| `go test -tags nogui ./internal/agent -count=1 -timeout 25m` (186.9 s) | ok but for `TestMothX`, red on this machine before this patch too (pre-existing, checked alone) |
| Ablation: the retry taken out of `dshTempHome`, the seven call sites kept | green on macOS as before — the only behavior added is the retry |
| `gofmt -l internal/agent/dsh_test.go` | empty |
| `go vet -tags nogui ./internal/agent` | clean |
| `go build -tags nogui ./...` | ok (the gui cgo warnings are pre-existing) |
| `git am -3` of the patch on a clean tree at `upstream/main` (`4164edce6`) | applies clean, targeted tests ok, author `ggbdpq <ggbdpq@gmail.com>` |
| Sibling check: the same env setup over `internal/agent` | ~100 test files set a temp home this way; the seven here are the `TestDsh` family the issue names — the helper stays local to `dsh_test.go`, ready to be shared if a sibling file needs it |

**Not verified**
On Windows: the failure is one-off under a scanner there, and this machine is macOS, where removing a folder whose file is still open succeeds (POSIX), so the race cannot be reproduced here. The retry covers the window the issue's own probe narrowed it to — nothing in the folder outlives the test on macOS, and a "not empty" folder resolves as soon as the scanner's handle closes. The issue's next step (`-count=50` under load, with Defender scanning the temp dir) is exactly the run this patch is for.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: dsh: a dsh test's temp home is given up only once it is really gone (#2982) — git am applies it as is; SHA-256 first 16: a092245dc425d5a6</summary>

```patch
From 3f6b58b26f517c653e29001bbe81456948bfc5a7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 5 Nov 2026 06:36:01 +0800
Subject: [PATCH] dsh: a dsh test's temp home is given up only once it is
 really gone

TestDshSetEffortWritesALegacyEntryWithTheCatalog died once at cleanup,
not in its body: on Windows, t.TempDir's RemoveAll found .config/magpie
not empty (LoKi's box, reported by yetone, #2982). Save replaces
providers.json by renaming a file over it, and a scanner holding the
file that was just renamed over keeps its entry listed while the entry
is pending deletion, so the folder reads as not empty for a moment;
t.TempDir's own cleanup retries a sharing violation but not a
"not empty" one, so it gave up on the first try. The seven dsh tests
that set up such a home now share dshTempHome, which tries the removal
until the folder is really gone, for a short while, before t.TempDir's
cleanup gets its turn.

Not verified on Windows: the failure is one-off under a scanner there,
and on macOS removing a folder whose file is still open succeeds, so
the race cannot be reproduced on this machine. With the retry taken
out the suite is green on macOS as before, so the only change in
behavior is the retry itself.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/agent/dsh_test.go | 69 ++++++++++++++++++--------------------
 1 file changed, 32 insertions(+), 37 deletions(-)

diff --git a/internal/agent/dsh_test.go b/internal/agent/dsh_test.go
index 50c1d81fc..0913cf7be 100644
--- a/internal/agent/dsh_test.go
+++ b/internal/agent/dsh_test.go
@@ -6,6 +6,7 @@ import (
 	"strconv"
 	"strings"
 	"testing"
+	"time"
 
 	"gopkg.in/yaml.v3"
 
@@ -14,13 +15,37 @@ import (
 	"github.com/yetone/magpie/internal/provider"
 )
 
-func TestDsh(t *testing.T) {
+// dshHome is a temp home a dsh test runs in, with magpie's own files kept
+// under it: the env vars point at it, and it is given up before the test
+// returns. Its removal is tried here until it is really gone, for a short
+// while: Save replaces providers.json by renaming a file over it, and on
+// Windows a scanner holding the file that was just renamed over keeps its
+// entry listed while it is pending deletion, so .config/magpie reads as
+// not empty for a moment — t.TempDir's own cleanup retries a sharing
+// violation but not a "not empty" one, and gave up on that once (test
+// passed, process failed; once on a Windows box, #2982). Past the short
+// wait the folder is left to t.TempDir's cleanup, which reports what it
+// sees.
+func dshTempHome(t *testing.T) string {
+	t.Helper()
 	home := t.TempDir()
 	t.Setenv("HOME", home)
 	t.Setenv("USERPROFILE", home)
 	t.Setenv("DSH_HOME", "")
 	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
 	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	t.Cleanup(func() {
+		for end := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
+			if err := os.RemoveAll(home); err == nil || time.Now().After(end) {
+				return
+			}
+		}
+	})
+	return home
+}
+
+func TestDsh(t *testing.T) {
+	home := dshTempHome(t)
 	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
 		t.Fatal(err)
 	}
@@ -91,12 +116,7 @@ func TestDsh(t *testing.T) {
 // Since 0.1.5 each profile has its own patch list, the key is a credential
 // and new sessions start on agent-default-model.
 func TestDshProfiles(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	home := dshTempHome(t)
 	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
 		t.Fatal(err)
 	}
@@ -177,12 +197,7 @@ func TestDshSettingsEndpoint(t *testing.T) {
 // Without them dsh takes every model for a text-only one with a million
 // tokens of context and 256K out.
 func TestDshModelLimits(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	dshTempHome(t)
 	visionOff(t) // else v/see describes images to v/plain, which takes them then
 	if err := provider.Save(provider.Provider{ID: "v", Name: "V", Chat: "https://example.test/v1", Key: "k", Models: []string{"see", "plain"}}); err != nil {
 		t.Fatal(err)
@@ -212,12 +227,7 @@ func TestDshModelLimits(t *testing.T) {
 // the web version lists magpie's models, the desktop one DeepSeek's alone)
 // is reported and, on the next sync, given the model the web's has.
 func TestDshProfileMadeLater(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	home := dshTempHome(t)
 	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
 		t.Fatal(err)
 	}
@@ -267,12 +277,7 @@ func TestDshProfileMadeLater(t *testing.T) {
 // is nothing to write into that entry, so the effort change is refused rather
 // than blanking the models magpie put there.
 func TestDshSetEffortLeavesALegacyEntryWithNoCatalogAlone(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	home := dshTempHome(t)
 	if n := len(magpieModels("dsh")); n != 0 {
 		t.Fatalf("a catalog to write from: %d models", n)
 	}
@@ -295,12 +300,7 @@ func TestDshSetEffortLeavesALegacyEntryWithNoCatalogAlone(t *testing.T) {
 
 // With a catalog the legacy entry is rewritten as before.
 func TestDshSetEffortWritesALegacyEntryWithTheCatalog(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	home := dshTempHome(t)
 	if err := provider.Save(provider.Provider{ID: "deepseek", Name: "DeepSeek", Chat: "https://api.deepseek.com/v1", Key: "k", Models: []string{"pro", "flash"}}); err != nil {
 		t.Fatal(err)
 	}
@@ -331,12 +331,7 @@ func TestDshSetEffortWritesALegacyEntryWithTheCatalog(t *testing.T) {
 // window, so the user's 1M is what dsh is told, and maxTokens follows from
 // it (dshMaxTokens). The models.dev bytes are opencode's own entry.
 func TestDshToldTheWindowSetForACustomProvider(t *testing.T) {
-	home := t.TempDir()
-	t.Setenv("HOME", home)
-	t.Setenv("USERPROFILE", home)
-	t.Setenv("DSH_HOME", "")
-	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
-	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	dshTempHome(t)
 	if err := os.MkdirAll(filepath.Dir(catalog.CachePath()), 0o755); err != nil {
 		t.Fatal(err)
 	}
-- 
2.50.1 (Apple Git-155)

```

</details>

Branch with the commit: [fix/2982-tempdir-cleanup](https://github.com/ggbdpq/magpie/tree/fix/2982-tempdir-cleanup) (head `3f6b58b26f517c653e29001bbe81456948bfc5a7`).