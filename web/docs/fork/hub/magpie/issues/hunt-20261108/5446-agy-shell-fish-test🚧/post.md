@Ns2Kracy `TestAgyShell` failed on your fish-enabled Linux machine (your reproduction at 83545a5d8f, Go 1.27.3, and your cause analysis are both exactly right) because the test held the function magpie writes into `~/.config/fish/config.fish` to POSIX syntax — the same test passes on machines without fish, so it only ever surfaced for fish users. Test-only fix below, following your own analysis; no production behavior change.

**Root cause**: `TestAgyShell` (internal/agent/agy_shell_test.go:52 at your base) seeds only the POSIX profiles (`.zshrc`, `.bashrc`, `.bash_profile`) and then holds every path `update.ShellFunctionIn("agy")` returns to the POSIX fixture: the `function agy {` prefix, the `"$@"` forwarding, the `}` suffix. On a machine where fish is set up, `shellProfiles` (internal/update/shellfn_other.go:25) adds `~/.config/fish/config.fish` once `~/.config/fish` exists, and magpie writes the fish function there (internal/agent/agy.go, `agyFunction`'s fish branch: `function agy … end`, `$argv`), which can never satisfy those POSIX assertions.

**The fix**: the test now makes its temp home a fish user's on every machine, so the fish profile is exercised deterministically instead of only where fish happens to be installed: a `fish` executable in `~/.local/bin` (one of the folders `proc.FindShell` looks in, found by stat alone — nothing runs it) and the `~/.config/fish` folder fish makes on its first start, with `config.fish` seeded with the user's own line. Assertions then dispatch per profile kind: POSIX profiles keep the old assertions unchanged; `config.fish` gets fish's own words (`function agy` prefix, `agy run $argv`, `end` suffix) plus a negative check that no POSIX `"$@"` leaked into it, and `config.fish` is required to be among the profiles the function landed in, so fish coverage can't silently go away. The wired-again phase rewrites each profile with its own shell's user line, and stepping out must leave `config.fish` with the user's line alone, as it does the POSIX profiles.

<details><summary>patch: agent: TestAgyShell reads the fish profile's function as fish (#5446) — git am applies it as is; SHA-256 first 16: 0dba60fa2fb4e101</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 08:57:01 +0800
Subject: [PATCH] agent: TestAgyShell reads the fish profile's function as fish
 (#5446)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

TestAgyShell seeded the POSIX profiles alone and then held every
profile update.ShellFunctionIn("agy") names to the POSIX fixture: the
"function agy {" prefix, the "$@" forwarding, the "}" suffix. On a
fish user's machine (Ns2Kracy, Linux) the list includes
~/.config/fish/config.fish, whose function agy is fish's own words —
function agy … end, $argv — so the test failed there and passed on
machines without fish.

The test now makes the home a fish user's on every machine: a fish in
~/.local/bin (one of the folders the shell search looks in) and the
config folder fish makes on its first start, config.fish seeded with
the user's own line. Each profile's block is asserted in that shell's
own words, the fish one checked to have no POSIX "$@" in it, and
config.fish is required among the profiles the function landed in.
The wired-again start rewrites each profile with its own user line,
and stepping out leaves config.fish with the user's line alone, as it
does the POSIX profiles.
---
 internal/agent/agy_shell_test.go | 41 ++++++++++++++++++++++++++++++--
 1 file changed, 39 insertions(+), 2 deletions(-)

diff --git a/internal/agent/agy_shell_test.go b/internal/agent/agy_shell_test.go
index 8d5520bee..a42b4d7ee 100644
--- a/internal/agent/agy_shell_test.go
+++ b/internal/agent/agy_shell_test.go
@@ -5,6 +5,7 @@ package agent
 import (
 	"os"
 	"path/filepath"
+	"slices"
 	"strings"
 	"testing"
 
@@ -32,6 +33,17 @@ func TestAgyShell(t *testing.T) {
 	for _, n := range rcs {
 		os.WriteFile(filepath.Join(home, n), []byte(mine), 0o644)
 	}
+	// fish too, on every machine: magpie gives the function to each shell
+	// it finds, and on a fish user's (the reporter's) that is config.fish,
+	// whose function is fish's own words — a fish in the home's .local/bin
+	// (one of the folders the shell search looks in) and the config folder
+	// fish makes on its first start make this home one
+	os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755)
+	os.WriteFile(filepath.Join(home, ".local", "bin", "fish"), []byte("#!/bin/sh\n"), 0o755)
+	os.MkdirAll(filepath.Join(home, ".config", "fish"), 0o755)
+	fishConfig := filepath.Join(home, ".config", "fish", "config.fish")
+	mineFish := "alias ll 'ls -l'\n"
+	os.WriteFile(fishConfig, []byte(mineFish), 0o644)
 	a, err := Find("agy")
 	if err != nil {
 		t.Fatal(err)
@@ -46,9 +58,27 @@ func TestAgyShell(t *testing.T) {
 	if len(in) == 0 {
 		t.Fatal("no shell's profile has agy")
 	}
+	// the fish profile is among them, and each profile's block is in that
+	// shell's own words: the POSIX one keeps its braces and "$@", the fish
+	// one `$argv` and `end` — the POSIX assertions failed on config.fish
+	// (#5446)
+	if !slices.Contains(in, fishConfig) {
+		t.Fatalf("no fish's config.fish has agy: %v", in)
+	}
 	for _, p := range in {
 		b, _ := os.ReadFile(p)
-		if s := string(b); !strings.HasPrefix(s, mine+"\n# >>> magpie agy >>>\nfunction agy {\n") || !strings.Contains(s, ` agy run "$@"; else command agy "$@"; fi`) || !strings.HasSuffix(s, "}\n# <<< magpie agy <<<\n") {
+		s := string(b)
+		if p == fishConfig {
+			if !strings.HasPrefix(s, mineFish+"\n# >>> magpie agy >>>\nfunction agy\n") ||
+				!strings.Contains(s, " agy run $argv\n") ||
+				!strings.Contains(s, "command agy $argv\n") ||
+				!strings.HasSuffix(s, "end\n# <<< magpie agy <<<\n") ||
+				strings.Contains(s, `"$@"`) {
+				t.Fatalf("%s:\n%s", p, s)
+			}
+			continue
+		}
+		if !strings.HasPrefix(s, mine+"\n# >>> magpie agy >>>\nfunction agy {\n") || !strings.Contains(s, ` agy run "$@"; else command agy "$@"; fi`) || !strings.HasSuffix(s, "}\n# <<< magpie agy <<<\n") {
 			t.Fatalf("%s:\n%s", p, s)
 		}
 	}
@@ -65,7 +95,11 @@ func TestAgyShell(t *testing.T) {
 
 	// wired before the function was given: the next start gives it
 	for _, p := range in {
-		os.WriteFile(p, []byte(mine), 0o644)
+		if p == fishConfig {
+			os.WriteFile(p, []byte(mineFish), 0o644)
+		} else {
+			os.WriteFile(p, []byte(mine), 0o644)
+		}
 	}
 	if a.Typed() != "" {
 		t.Fatal("typed with no function")
@@ -86,6 +120,9 @@ func TestAgyShell(t *testing.T) {
 			t.Fatalf("%s after stepping out:\n%s", n, b)
 		}
 	}
+	if b, _ := os.ReadFile(fishConfig); string(b) != mineFish {
+		t.Fatalf("config.fish after stepping out:\n%s", b)
+	}
 	if a.Typed() != "" {
 		t.Fatal("typed after stepping out")
 	}
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5446-agy-shell-fish-test`](https://github.com/ggbdpq/magpie/tree/fix/5446-agy-shell-fish-test) (head `d48274c41ceb07c9bc53f4c84db38b74420c3513`), rebased onto current `upstream/main` (350599a0f); on a fresh checkout `git am` applies clean and the resulting tree matches byte for byte.

| Check | Result |
| --- | --- |
| `TestAgyShell` (reworked; with a fish in the home) | red under the old POSIX assertions at `config.fish` (your failure's shape), pass after |
| `TestAgyFunction` (unchanged neighbor) | pass |
| `go test ./internal/agent ./internal/update -tags nogui -timeout 30m -count=1` (darwin/arm64, Go 1.26.8) | `internal/update` ok (17.9s), zero failures; `internal/agent`: one failure, `TestMothX`, which fails the same on the base commit 350599a0f with this patch stashed (machine-specific, not touched by this test-only change — "fails the same on main" is not a baseline, listed as a failure); every other test in the package passes (183s) |
| `go test -tags nogui ./...` (temp HOME, pinned Go caches) | not run beyond the two packages above |
| targeted `-race` (`TestAgyShell`, `TestAgyFunction`) | pass |
| `gofmt -l internal/agent` | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | all clean |
| `go build`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | darwin and windows clean; plain `GOOS=linux go build` (no tags) is red inside wails v3.0.0-beta.24 itself (`undefined: pointer` in the module's menu_linux.go) — a dependency-level failure, listed as such; this patch touches a `_test.go` file only |
| Ablation | pointing the fish branch's prefix assertion back at the POSIX fixture turns `TestAgyShell` red at `config.fish` again; restored, green |
| Re-verified on upstream/main `350599a0f` | the commit sits directly on 350599a0f; `git am` into a fresh detached checkout at 350599a0f applies clean, tree identical |

**Not verified**: on a fish-installed Linux/WSL machine (the reporter's exact surface) — NOT-RUNNABLE here, this Mac has no fish; the fish in the fix is found by stat and never executed, and the same code path (profile listed, block written in fish's words) is what the reworked test checks. Windows is outside the test's `//go:build !windows` file, as before.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
