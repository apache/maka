The report's diagnosis is right, and I reproduced it on `95ef45fda4b3978e94f12954a27d41e5ef1dca85`. The fix is a small change to `runsBroken`: a CLI the kernel refuses to exec is a broken install when the npm package is one whose `bin` is a shebang-less native-binary stub. Everything else that never reached an exit code is still "unknown".

Branch: [`hunt44-c-agent-broken-stub`](https://github.com/ggbdpq/magpie/tree/hunt44-c-agent-broken-stub), one commit on top of upstream `95ef45fda4b3978e94f12954a27d41e5ef1dca85`; the diff below applies on it.

## What changed

`internal/agent/cliupdate.go`:

- `stubShims` (line 1030) lists the npm packages whose `bin` is a shebang-less text stub that only runs once postinstall has fetched the platform-native optional package: `@anthropic-ai/claude-code` and `opencode-ai`.
- `runsBroken` (line 1045) now separates "did not exec" from "ran and failed":

```go
out, code, err := runCheck(ctx, bin, updateEnv(u))
if err == nil || ctx.Err() != nil || code == 127 || parseVersion(out) != "" {
	return ""
}
if code <= 0 {
	// the kernel wouldn't exec it: a native CLI's npm stub without its
	// binary is a shebang-less text file, so this is the broken install
	// #2128 is about (#2798). Any other run that never started says
	// nothing about the update.
	if errors.Is(err, syscall.ENOEXEC) && contains(stubShims, u.pkg) {
		return "exec format error"
	}
	return ""
}
if msg := lastLines(out, 2); msg != "" {
	return msg
}
return fmt.Sprintf("exit status %d", code)
```

The old single guard was `err == nil || ctx.Err() != nil || code <= 0 || code == 127 || parseVersion(out) != ""`. `code <= 0` meant "the run did not reach an exit code, so nothing is known" — right for a missing binary or a timeout, wrong for the Claude Code stub, whose `execve` returns `ENOEXEC`. Now:

- `code == 127` (command not found / interpreter missing) is still not broken.
- `parseVersion(out) != ""` (a CLI that says a version) is still not broken.
- `code <= 0` for any other reason, or for a package not in `stubShims`, is still unknown.
- Only `ENOEXEC` on a stub package is broken, and the message is `exec format error` (the stub prints nothing: the kernel never runs it).

`internal/agent/cliupdate_runs_test.go` adds `claudeStub`, the real 500-byte `bin/claude.exe` from `npm pack @anthropic-ai/claude-code@2.1.302` (no shebang), and `TestRunsBrokenSeesAShebanglessStub`, which writes it into a temp dir and runs it through the real `runCheck` (not the fake hook).

## Red before the fix

Base `95ef45fda4b3978e94f12954a27d41e5ef1dca85`, new test only:

```text
$ go test -tags nogui -count=1 -run TestRunsBrokenSeesAShebanglessStub -v ./internal/agent/
=== RUN   TestRunsBrokenSeesAShebanglessStub
    cliupdate_runs_test.go:159: @anthropic-ai/claude-code: a stub the kernel won't run: "", want it said as broken
    cliupdate_runs_test.go:159: opencode-ai: a stub the kernel won't run: "", want it said as broken
--- FAIL: TestRunsBrokenSeesAShebanglessStub (0.01s)
FAIL	github.com/yetone/magpie/internal/agent	1.051s
```

The real stub's exec result on macOS (darwin/arm64, Go 1.26.8), captured by running `exec.Command(stub, "--version").CombinedOutput()`:

```text
out=""
code=-1 (no ExitError)
err=fork/exec ./claude.exe: exec format error
ENOEXEC=true
```

With the fix, the same test passes. The existing #2128 test (`TestUpdateCLIChecksItRuns`, whose stub has `#!/bin/sh`) is unchanged and still passes.

Ablation: restoring `git show upstream/main:internal/agent/cliupdate.go` with the new test kept turns it red with the same two lines above; restoring the change turns it green.

## Verification

| Check | Result |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestUpdateCLI\|TestRunsBroken\|TestHowInstalled' ./internal/agent/` | ok, 3.009s |
| `go test -tags nogui -count=1 ./internal/agent/` | 199.426s; only `TestMothX` fails, environmental (see below) |
| `go test -race -tags nogui -count=1 -run 'TestRunsBroken\|TestUpdateCLI' ./internal/agent/` | ok, 2.923s |
| `gofmt -l internal/agent/` | empty |
| `go vet -tags nogui ./internal/agent/` | exit 0 |
| `GOOS=linux go vet -tags nogui ./internal/agent/` | exit 0 |
| `GOOS=windows go vet -tags nogui ./internal/agent/` | exit 0 |
| `go build -tags nogui ./...` (darwin) | exit 0 (one pre-existing cgo enum warning from `internal/gui`) |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -o /dev/null .` | exit 0 |

`TestMothX` fails on this machine because a real `mothx` is on `PATH`, and the test asserts the agent is not detected. It fails the same way on the base commit without this change, and passes with `mothx` removed from `PATH`:

```text
$ PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /usr/local/go/bin/go test -tags nogui -count=1 -run 'TestMothX$' ./internal/agent/
ok  	github.com/yetone/magpie/internal/agent	1.295s
```

Break checks: disabling the new `ENOEXEC` branch fails the new test with the same two lines; moving `code == 127` into the new branch fails the existing 127 case in `TestRunsBrokenOnlyWhenSure`; dropping the `parseVersion(out) != ""` guard fails its working-CLI case. All restored afterwards.

## Siblings

Every npm package in `cliSpecs` was checked with `npm view <pkg> bin` and `npm pack` (versions of 2026-10-18):

| Package | `bin` | Shape | Affected |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-code` | `bin/claude.exe` | 500-byte text, no shebang | **yes** |
| `opencode-ai` | `bin/opencode.exe` | 479-byte text, no shebang | **yes** |
| `@openai/codex` | `bin/codex.js` | `#!/usr/bin/env node` | no |
| `@deveco/deveco-code` | `bin/deveco` | `#!/usr/bin/env node` | no |
| `@oh-my-pi/pi-coding-agent` (omp) | `dist/cli.js` | `#!/usr/bin/env bun` | no |
| `omo-ai` (omo) | `bin/omo.js` | `#!/usr/bin/env node` | no |
| `@google/gemini-cli` | `bundle/gemini.js` | `#!` script | no |
| `@earendil-works/pi-coding-agent`, `@mariozechner/pi-coding-agent` | `dist/**/cli.js` | `#!` script | no |
| `@github/copilot` | `npm-loader.js` | `#!` script | no |
| `@charmland/crush` | `run-crush.js` | `#!` script | no |
| `cline` | `bin/cline` | `#!/usr/bin/env node` | no |
| `@deepseek-ai/dsh` | `lib/bin.js` | `#!/usr/bin/env node` | no |
| `@tencent-ai/codebuddy-code` | `./bin/codebuddy` | `#!/usr/bin/env node` | no |
| `@atomgit.com/atomcode` | `bin/atomcode.js` | `#!/usr/bin/env node` | no |
| `snow-ai` | `bundle/cli.mjs` | `#!` script | no |
| `mothx-installer` | `bin/mothx` | `#!/usr/bin/env node` | no |

Grok Build and omp's own installer (not npm) ship real native binaries, so the kernel can exec them; they are untouched. The two affected packages are both in `stubShims`; nothing else changed.

Why not treat every `ENOEXEC` as broken: `TestGrokInstalled` and other existing tests use a text file such as `MZ` as a stand-in for a native binary. An unconditional `ENOEXEC` check turns `TestGrokInstalled` red on this machine. The package list keeps "a non-stub package that didn't start is unknown" intact, which is also the existing contract of `runsBroken`.

## Not verified

- No end-to-end reproduction of a real npm update that drops Claude Code's native optional package. The stub bytes come from `npm pack @anthropic-ai/claude-code@2.1.302`, and the exec path is the real `runCheck`, but the full "npm update leaves the stub → `UpdateCLI` repairs it" flow is only covered by the existing `TestUpdateCLIChecksItRuns`, whose stub has a shebang and is unchanged.
- Windows was not run. `TestRunsBrokenSeesAShebanglessStub` skips there, and Windows has no shebang-less stub path anyway (npm's shim runs the `.exe` through `cmd.exe`). Only `GOOS=windows go vet` and `go build` were run.
- `stubShims` is a package-name list. A future CLI that switches to a shebang-less stub needs adding there; the comment beside it says so.

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.

**Attribution**: If you apply the patch, please keep its author (ggbdpq) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

<details><summary>patch: agent: a Claude Code stub that cannot be exec'd is a broken install, not an unknown one (#2798)</summary>

```diff
diff --git a/internal/agent/cliupdate.go b/internal/agent/cliupdate.go
index dcebb7e4..3ff830d3 100644
--- a/internal/agent/cliupdate.go
+++ b/internal/agent/cliupdate.go
@@ -24,6 +24,7 @@ import (
 	"strconv"
 	"strings"
 	"sync"
+	"syscall"
 	"time"
 	"unicode/utf16"
 
@@ -1026,16 +1027,36 @@ func (a *Agent) UpdateCLI() (CLI, error) {
 	return c, nil
 }
 
+// stubShims are the npm packages whose bin is a shebang-less text stub that
+// only runs once postinstall has fetched the platform-native optional
+// package: Claude Code's bin/claude.exe (#2798) and opencode's
+// bin/opencode.exe. Every other CLI magpie updates has a #! script or a real
+// binary as its bin.
+var stubShims = []string{"@anthropic-ai/claude-code", "opencode-ai"}
+
 // runsBroken is what bin --version says when it ran and failed without
 // saying a version, "" when it said one or what it is can't be told: it
 // didn't start, took too long, or its interpreter wasn't found (127), none
-// of which says the update broke it. It runs as the update did, its npm's
-// folder first on PATH, so a node CLI finds the node it was installed for.
+// of which says the update broke it. One the kernel refused to exec is
+// broken, though, when its package's bin is such a stub: no shebang, no
+// native package, nothing to say but exec format error (#2798). It runs as
+// the update did, its npm's folder first on PATH, so a node CLI finds the
+// node it was installed for.
 func runsBroken(ctx context.Context, bin string, u *updater) string {
 	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
 	defer cancel()
 	out, code, err := runCheck(ctx, bin, updateEnv(u))
-	if err == nil || ctx.Err() != nil || code <= 0 || code == 127 || parseVersion(out) != "" {
+	if err == nil || ctx.Err() != nil || code == 127 || parseVersion(out) != "" {
+		return ""
+	}
+	if code <= 0 {
+		// the kernel wouldn't exec it: a native CLI's npm stub without its
+		// binary is a shebang-less text file, so this is the broken install
+		// #2128 is about (#2798). Any other run that never started says
+		// nothing about the update.
+		if errors.Is(err, syscall.ENOEXEC) && contains(stubShims, u.pkg) {
+			return "exec format error"
+		}
 		return ""
 	}
 	if msg := lastLines(out, 2); msg != "" {
diff --git a/internal/agent/cliupdate_runs_test.go b/internal/agent/cliupdate_runs_test.go
index 1ae19db6..b32bb234 100644
--- a/internal/agent/cliupdate_runs_test.go
+++ b/internal/agent/cliupdate_runs_test.go
@@ -128,3 +128,41 @@ func TestRunsBrokenOnlyWhenSure(t *testing.T) {
 		t.Errorf("a CLI that didn't start: %q", got)
 	}
 }
+
+// claudeStub is @anthropic-ai/claude-code 2.1.302's bin/claude.exe, the
+// 500 bytes npm leaves when its optional native package isn't fetched. It
+// has no shebang: a shell runs it, the kernel won't (#2798).
+const claudeStub = `echo "Error: claude native binary not installed." >&2
+echo "" >&2
+echo "Either postinstall did not run (--ignore-scripts, some pnpm configs)" >&2
+echo "or the platform-native optional dependency was not downloaded" >&2
+echo "(--omit=optional)." >&2
+echo "" >&2
+echo "Run the postinstall manually (adjust path for local vs global install):" >&2
+echo "  node node_modules/@anthropic-ai/claude-code/install.cjs" >&2
+echo "" >&2
+echo "Or reinstall without --ignore-scripts / --omit=optional." >&2
+exit 1
+`
+
+// The real Claude Code stub can't be exec'd at all: no shebang, so Go says
+// "exec format error" with no output and no exit code. That is the broken
+// install #2128 is about, not a run that can't be told about (#2798).
+func TestRunsBrokenSeesAShebanglessStub(t *testing.T) {
+	if runtime.GOOS == "windows" {
+		t.Skip("Windows has no shebang-less stub: npm's shim runs the .exe through cmd.exe")
+	}
+	bin := file(t, filepath.Join(t.TempDir(), "claude.exe"), claudeStub)
+	for _, pkg := range []string{"@anthropic-ai/claude-code", "opencode-ai"} {
+		u := &updater{via: "npm", pkg: pkg, cmd: []string{"npm"}}
+		if got := runsBroken(context.Background(), bin, u); !strings.Contains(got, "exec format error") {
+			t.Errorf("%s: a stub the kernel won't run: %q, want it said as broken", pkg, got)
+		}
+	}
+	// a bin the kernel won't run for a package that doesn't ship such a
+	// stub is still unknown, not broken: its update may be fine
+	u := &updater{via: "npm", pkg: "some-other-cli", cmd: []string{"npm"}}
+	if got := runsBroken(context.Background(), bin, u); got != "" {
+		t.Errorf("a bin that didn't start for another package: %q", got)
+	}
+}
```

</details>
