Patch: `fix/2837-opencode-upgrade` — https://github.com/ggbdpq/magpie/tree/fix/2837-opencode-upgrade — commit `68d29137`, base `d783df46`. Patch sha256 `c5a803b17a0fc9c0f302d4c6b1b02693f65a2b9ddda9b182453b3e106335c136`.

The change is the one proposed in the report: `cliSpec.target` marks the CLI whose own updater takes the version to install (`opencode` sets it), and `UpdateCLI` appends the row's `Latest` when it is newer than the installed one, so the run is `opencode upgrade 1.19.3` rather than the untargeted command whose own `latest()` is the 403. `CLI.Command` and `CLI.Update` — what the row shows — are unchanged; a stale npm answer appends nothing.

Red without the fix (base `d783df46`, the `UpdateCLI` block reverted, the new test kept):

```
--- FAIL: TestUpdateCLIOpenCodeTakesVersion (0.81s)
    cliupdate_test.go:411: ran [["…/bin/opencode" "upgrade"]]
```

With it: `ok github.com/yetone/magpie/internal/agent 1.808s` for `go test -tags nogui ./internal/agent -run 'TestUpdateCLIOpenCodeTakesVersion|TestUpdateCLI$|TestHowInstalled$'` in a temp HOME and GOCACHE. `gofmt -l` on both files: nothing. `go vet -tags nogui ./internal/agent`, `GOOS=linux go vet -tags nogui ./internal/agent`, `GOOS=windows go vet -tags nogui ./internal/agent`: ok. `go build ./...`, `GOOS=linux go build -tags nogui ./...`, `GOOS=windows go build ./...`: ok.

Not run: `go test -tags nogui ./...`. `./internal/agent` run whole is red here in `TestMothX` only (this machine's PATH carries a real `mothx`), which is not this change.

---
**Source**: my own use on macOS, quoted in the report (Agents page → Update all, opencode 1.19.0).

**Siblings**: `internal/agent/cliupdate.go` has 7 `self` updaters (claude, codex, deveco, opencode, grok, omp, omo). Only opencode's shipped updater was verified to take a version to install, so only it sets `target`; the others' commands take none. The npm, bun, pnpm and brew paths ask registries and formulae, not GitHub's API, and an opencode installed by any of them is unaffected.

**When the read fails**: npm's answer missing, or not newer than the installed version, appends nothing and the run is today's untargeted `opencode upgrade`; `Newer` keeps an older answer from turning the update into a downgrade.

**Not verified**: no end-to-end run of this build against a real opencode with the address's API allowance spent again; the failing path was read from the installed 1.19.0 bundle, quoted in the report.

**Attribution**: if the patch is applied, please keep its author (`ggbdpq`) or add a `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` line.

**AI**: I have read the whole diff and can answer questions on it myself.

<details>
<summary>patch (for git am)</summary>

```diff
From 68d29137e43c7108730e16edc7f5c1c8414f2b07 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 18 Oct 2026 21:10:32 +0800
Subject: [PATCH] agent: opencode's update passes the version its row promised,
 so it never asks GitHub's API (#2837, ggbdpq)

What changed: an opencode 1.19.0 that its own installer put at
~/.opencode/bin/opencode (method curl) asks GitHub's API
GET /repos/anomalyco/opencode/releases/latest for the newest release before
installing. That request carries no token, so it spends the 60 an hour GitHub
answers an address without one; once spent it is a 403 and the update stops
before its installer runs (ggbdpq: "opencode upgrade: ... 403 GET
https://api.github.com/repos/anomalyco/opencode/releases/latest").

cliSpec gains target, for a CLI whose own updater takes the version to
install, and opencode sets it. UpdateCLI then appends the version it already
knows, the row's Latest from npm's opencode-ai, when that is newer than the
installed one: the run is "opencode upgrade 1.19.3". opencode's handler takes
a target and skips its own latest(), and the installer downloads that version
from the release instead. A stale npm answer appends nothing (Newer), so an
update can never become a downgrade; when the lookup fails the command is
today's "opencode upgrade". CLI.Command and CLI.Update, what the row shows,
are unchanged.

Run: HOME=<temp> GOCACHE=<temp> go test -tags nogui ./internal/agent -run
'TestUpdateCLIOpenCodeTakesVersion|TestUpdateCLI$|TestHowInstalled$'
  ok github.com/yetone/magpie/internal/agent 1.808s
With the UpdateCLI block reverted and the new test kept:
  --- FAIL: TestUpdateCLIOpenCodeTakesVersion (0.81s)
      cliupdate_test.go:411: ran [[".../bin/opencode" "upgrade"]]
Restored: ok again.
gofmt -l on both files: nothing.
go vet -tags nogui ./internal/agent; GOOS=linux go vet -tags nogui
./internal/agent; GOOS=windows go vet -tags nogui ./internal/agent: ok.
go build ./...; GOOS=linux go build -tags nogui ./...; GOOS=windows
go build ./...: ok.
Not run: go test -tags nogui ./... . ./internal/agent run whole has one red,
TestMothX, because this machine's PATH carries a real mothx; not this change.

Generated-by: deepseek-flash (DeepSeek Harness)
---
 internal/agent/cliupdate.go      | 18 +++++++++++-
 internal/agent/cliupdate_test.go | 47 ++++++++++++++++++++++++++++++++
 2 files changed, 64 insertions(+), 1 deletion(-)

diff --git a/internal/agent/cliupdate.go b/internal/agent/cliupdate.go
index ffbd1ef2..0304c808 100644
--- a/internal/agent/cliupdate.go
+++ b/internal/agent/cliupdate.go
@@ -82,6 +82,15 @@ type cliSpec struct {
 	// latest is the newest version its own updater would install, for one
 	// not published on npm
 	latest func() string
+	// target: its own updater takes the version to install (opencode
+	// upgrade 1.19.3), so magpie gives it the one it already knows, as the
+	// row promised. An opencode 1.19.0 from its own installer (method curl)
+	// asks GitHub's API for the newest release, which answers an address 60
+	// times an hour without a token and 403s once that is spent; 1.19.3 asks
+	// npm there instead, but only an update gets there (#2837, ggbdpq:
+	// "opencode upgrade: ... 403 GET https://api.github.com/repos/
+	// anomalyco/opencode/releases/latest")
+	target bool
 	// only are the systems (GOOS) its vendor builds it for, when not all:
 	// on any other its package installs nothing that runs
 	only []string
@@ -121,7 +130,7 @@ var cliSpecs = map[string]cliSpec{
 			}
 			return nil
 		}},
-	"opencode": {npm: []string{"opencode-ai"}, brew: []string{"opencode"},
+	"opencode": {npm: []string{"opencode-ai"}, brew: []string{"opencode"}, target: true,
 		self: func(bin, real string) []string {
 			if strings.Contains(real, "/.opencode/bin/") {
 				return []string{bin, "upgrade"}
@@ -948,6 +957,13 @@ func (a *Agent) UpdateCLI() (CLI, error) {
 	}
 	defer updating.Delete(a.ID)
 	before := installedVersion(real)
+	if spec.target {
+		// the version the row promised, so its own updater needn't ask
+		// GitHub's API for the newest (see cliSpec.target)
+		if v := latestVersion(u); Newer(v, before) {
+			u.cmd = append(u.cmd, v)
+		}
+	}
 	ctx, cancel := context.WithTimeout(context.Background(), updateTimeout)
 	defer cancel()
 	run := runUpdate
diff --git a/internal/agent/cliupdate_test.go b/internal/agent/cliupdate_test.go
index cf97ef9d..68f32d30 100644
--- a/internal/agent/cliupdate_test.go
+++ b/internal/agent/cliupdate_test.go
@@ -365,6 +365,53 @@ func TestUpdateCLI(t *testing.T) {
 	}
 }
 
+// An opencode 1.19.0's upgrade asks GitHub's API for the newest release,
+// which answers an address 60 times an hour without a token before a 403
+// (ggbdpq: "opencode upgrade: ... 403 GET https://api.github.com/repos/
+// anomalyco/opencode/releases/latest"). magpie gives it the version the row
+// promised, which its installer downloads from the release itself.
+func TestUpdateCLIOpenCodeTakesVersion(t *testing.T) {
+	if runtime.GOOS == "windows" {
+		t.Skip("a shell script as the CLI")
+	}
+	tmp, _ := filepath.EvalSymlinks(t.TempDir())
+	verFile := filepath.Join(tmp, "version")
+	os.WriteFile(verFile, []byte("1.19.2\n"), 0o644)
+	oc := file(t, filepath.Join(tmp, "home/.opencode/bin/opencode"), "#!/bin/sh\n/bin/cat "+verFile+"\n")
+	bin := link(t, oc, filepath.Join(tmp, "bin/opencode"))
+	t.Setenv("PATH", filepath.Dir(bin))
+
+	reg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		if r.URL.Path != "/opencode-ai/latest" {
+			http.NotFound(w, r)
+			return
+		}
+		w.Write([]byte(`{"name":"opencode-ai","version":"1.19.3"}`))
+	}))
+	defer reg.Close()
+	oldReg, oldRun := npmRegistry, runUpdate
+	npmRegistry = reg.URL + "/"
+	versions, latests = memo{}, memo{}
+	var ran [][]string
+	runUpdate = func(_ context.Context, u *updater) ([]byte, error) {
+		ran = append(ran, u.cmd)
+		os.WriteFile(verFile, []byte("1.19.3\n"), 0o644)
+		return nil, nil
+	}
+	t.Cleanup(func() { npmRegistry, runUpdate = oldReg, oldRun; versions, latests = memo{}, memo{} })
+
+	a := &Agent{ID: "opencode", Name: "OpenCode", Bin: "opencode"}
+	if c, ok := a.CLI(); !ok || c.Via != "self" || c.Version != "1.19.2" || c.Latest != "1.19.3" || !c.Update {
+		t.Fatalf("before: %+v", c)
+	}
+	if c, err := a.UpdateCLI(); err != nil || c.Version != "1.19.3" || c.Update {
+		t.Fatalf("after: %+v, %v", c, err)
+	}
+	if len(ran) != 1 || !reflect.DeepEqual(ran[0], []string{bin, "upgrade", "1.19.3"}) {
+		t.Errorf("ran %q", ran)
+	}
+}
+
 // An agent's CLI installed with bun is updated by bun add -g, which can't
 // use a SOCKS5 proxy (#1409): it is given the bridge in front of it. npm,
 // which can, is given the proxy as it is.
-- 
2.50.1 (Apple Git-155)
```

</details>
