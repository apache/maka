Rebased onto `318697dc` after upstream `a2573199` (plugin: an install takes the versions no longer installed out of Bun's cache, #1988) reshaped `internal/plugin/bun.go`; the behavior is unchanged. The conflict was the cache-path helper: upstream folded the inline `BUN_INSTALL_CACHE_DIR` path into `installCacheDir` (`internal/plugin/installcache.go`) and dropped `bun.go`'s `catalog` import, so this rebase drops the patch's own `bunCacheDir` helper — `bun.go` is no longer touched at all — and `refreshGitCache` uses upstream's `installCacheDir` instead (the doc paragraph's link now points there too). The new prune does not interact with the git clones: `pruneCached` only takes out entries shaped `name@version@@registry…` whose version isn't installed (plus links left dangling), and a bare clone's `<16-hex>.git` name has no `@` in it, so the clones `refreshGitCache` fetches into are untouched.

On this base, without the fix the same tests still fail: `TestGitUpdateInstallsTheBranchsCommitNow` and `TestGitUpdateSaysWhenItDidnt` (details at the bottom).

## Verification

| Check | Command | Result |
| --- | --- | --- |
| New tests + git neighbors | `go test ./internal/plugin/ -run Git -count=1 -v` | ok, 5.2s, exit 0 — `TestGitUpdateInstallsTheBranchsCommitNow`, `TestGitUpdateKeepsACommitPin` (real bun 1.4.2, local `git+file://` repository), `TestGitUpdateSaysWhenItDidnt` (fake bun keeping the lock's commit), `TestRefFixed`, `TestSameRepoAndCloneOrigin` and the pre-existing git tests all pass |
| Plugin package, full suite | `go test ./internal/plugin/... -count=1 -timeout 20m` | ok, 171s, exit 0 |
| Race | `go test -race ./internal/plugin/ -run Git -count=1` | ok, 33s, exit 0 |
| Format | `gofmt -l` on the changed Go files | clean |
| Vet | `go vet ./internal/plugin/` | ok |
| Builds | `GOOS=darwin GOARCH=arm64 go build ./...`; `GOOS=windows GOARCH=amd64 go build ./...`; linux as the Makefile cross-compiles it, `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui ./...` | all ok, exit 0 (a plain linux `go build ./...` fails inside wails' Linux GUI code on this machine — third-party, pre-existing, untouched by this patch) |
| Ablation: wiring reverted | `store.go` back to upstream, the new `gitrev.go` kept but unwired, tests kept | `TestGitUpdateInstallsTheBranchsCommitNow` and `TestGitUpdateSaysWhenItDidnt` FAIL (assertions below); `TestGitUpdateKeepsACommitPin` stays green |
| Ablation: fetch dropped | `refreshGitCache` returns nil first | only `TestGitUpdateInstallsTheBranchsCommitNow` FAIL — the stale clone resolves the old commit again |
| Ablation: still-behind report dropped | the `GitHeadCached`/`GitBehind` check removed from `reinstall` | only `TestGitUpdateSaysWhenItDidnt` FAIL — the false success is back |
| Ablation: pins treated as unfixed | `refFixed` returns false | all `-run Git` tests green: the pin stands by Bun's own semantics, the skip only saves a pinned plugin's update the fetch |

Every ablation was restored afterwards; the working tree is the commit below.

---
**Source**: reported in #2954; this comment re-bases the earlier patch after an upstream change to the same file.

**Red without the fix** (base `318697dc`): with the product wiring reverted and the new tests kept, `go test ./internal/plugin -run Git` fails:
```
--- FAIL: TestGitUpdateInstallsTheBranchsCommitNow (0.28s)
    plugin_gitupdate_test.go:79: the update said it is done, the plugin is still at 1.0.0, want 2.0.0
--- FAIL: TestGitUpdateSaysWhenItDidnt (0.21s)
    plugin_gitupdate_test.go:121: the update said it is done, though the plugin is still at the commit it was at
```
With the fix: `ok`.

**Siblings**: `rg -n 'git|clone|FETCH_HEAD|refs/heads' internal/plugin --type go` outside the tests — the resolve paths are the two this patch wires: `install` (bun add: `Add`, `InstallMissing`, and `keepMovedCurrent` in `internal/provider/migrate.go` through `Add` — best-effort refresh) and `reinstall` (bun update: `Update`'s git branch, `Upgrade`, the page's update — strict refresh plus the still-behind report); everything else only reads git state and is unchanged on purpose: `github.go`'s and `market.go`'s `IsGit` spec classification (no cache reading), `updates.go`'s `Pinned` (a git spec is never pinned) and the page's `GitBehind` compare (unchanged — the fix makes the update install what that compare saw), and the `bun.lock` readers `GitCommit`/`GitHeads` (the lock now records the commit that was actually resolved, so their answers get truer).

**When the read fails**: with no clone of the repository in the cache (GitHub's tarballs, a first install) or an unreadable cache dir there is nothing to refresh and this is nil — today's behavior; a fetch that fails is ignored by `install` (best-effort, the cache has what it has) and reported by `reinstall` (an update that didn't happen is not claimed), and `git` missing from PATH only surfaces where a matching clone exists — a spec bun can only install through git anyway.

**Not verified**: the reporter's intranet HTTPS host (everything here is a local `git+file://` remote with the bun on PATH, 1.4.2 — the version magpie runs); the bundled-bun download path (the tests point `MAGPIE_BUN` at the local one); how long the first update takes on a big repository (the fetch is bounded at a minute per clone).

Branch with the commit: [hunt50-c-git-plugin-lock](https://github.com/ggbdpq/magpie/tree/hunt50-c-git-plugin-lock) (head `298be6db0`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: plugins: an update of an unfixed git source re-resolves the branch, not the lock's old commit (#2954) — git am applies it as is; SHA-256 first 16: a919403d0138a990</summary>

```patch
From 298be6db01a394ac8294067f5a41cc686c82d775 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 20 Oct 2026 08:23:37 +0800
Subject: [PATCH] plugins: an update of an unfixed git source re-resolves the
 branch, not the lock's old commit (#2954)

What changed
- Before Bun resolves a git plugin's spec, the branches and tags of its
  repository are fetched into the bare clone Bun keeps in its install
  cache (refreshGitCache in gitrev.go): best-effort before install's
  bun add (a remote that can't be reached leaves the install to what the
  cache has), an error before reinstall's bun update (an update that
  didn't happen is not reported as done).
- When bun update exits 0 but the plugin is still behind the commit the
  update checks saw the repository at, reinstall says so instead of
  claiming the update.
- A spec that names a commit (#<sha>) is left alone: nothing is resolved
  for one, and its pin stands.
- docs/subsystems/provider-plugins.md: this git update path.

Why
A plugin added from an unfixed git+https://... URL could not be updated
(#2954): plugins/package.json named no commit, but Bun resolves a git
spec through its own bare clone of the repository in the install cache,
whose refs stay at the first install - a fetch there moves FETCH_HEAD,
not the clone's refs/heads. Every resolve after the first, bun update as
much as a bun add after a remove, therefore named the old commit again,
bun.lock re-recorded it (name@git+...#bb961b2...), and the update said it
had installed while node_modules kept 0.1.3. The lock is the record of
that resolution, not its cause. Verified with Bun 1.4.2 (the version
magpie runs) against a local git+file:// repository: after the branch
moved, bun update my-plugin answered "no changes" and exited 0, and so
did bun install with the lock entry dropped, bun update --force and bun
install --force; with the clone's refs fetched, the same bun update
installed the branch's commit now.

Run
go test ./internal/plugin/ -count=1 (ok; new: TestGitUpdateInstallsTheBran
chsCommitNow and TestGitUpdateKeepsACommitPin on the bun on PATH against
a local git+file:// repository, TestGitUpdateSaysWhenItDidnt with the
fake bun keeping the lock's commit, TestRefFixed,
TestSameRepoAndCloneOrigin)
go test ./internal/cli/ ./internal/provider/ -count=1 (ok)
gofmt -l (clean); go vet ./internal/plugin/ on darwin, linux and windows
(ok); builds of darwin and of windows (CGO_ENABLED=0 -tags production,
as the Makefile cross-compiles it) and of the 79 Linux packages that
don't need Linux GTK cgo (the GUI and cli are built natively per machine,
as the Makefile says).

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/provider-plugins.md      |   2 +
 internal/plugin/gitrev.go                | 124 ++++++++++++++
 internal/plugin/plugin_git_test.go       |   8 +-
 internal/plugin/plugin_gitupdate_test.go | 200 +++++++++++++++++++++++
 internal/plugin/store.go                 |  33 +++-
 5 files changed, 361 insertions(+), 6 deletions(-)
 create mode 100644 internal/plugin/plugin_gitupdate_test.go

diff --git a/docs/subsystems/provider-plugins.md b/docs/subsystems/provider-plugins.md
index b6cfbf4a..eee30b89 100644
--- a/docs/subsystems/provider-plugins.md
+++ b/docs/subsystems/provider-plugins.md
@@ -156,6 +156,8 @@ A `@magpie-community` package npm doesn't give is installed from the community r
 
 A plugin on the list whose package isn't in `plugins/` is installed again from its own spec, switched off or not, by `plugin.InstallMissing`. `KeepUpdated` runs it 30 seconds after start and then hourly, before `CheckUpdates`. Nothing else did this. An update skips a plugin with no installed version, so the host said `no such plugin: …\node_modules\…` at every start until the user removed the plugin and added it again (#2002, Windows, after an update). Every bun command that changes `plugins/` runs one at a time under `installMu`: `install` (with the first `package.json` it writes), `reinstall`'s `bun update`, and `Remove`'s and `add`'s `bun remove`. At start, `KeepUpdated` and `keepMovedCurrent` both run `bun add`. Two at once each read `package.json` before either writes it, so one change was lost (reproduced with Bun 1.4.3 on Windows), and a git plugin whose dependency was dropped can't be found. `TestMissingPluginsInstalledAgain` and `TestBunCommandsOneAtATime` in [`plugin_missing_test.go`](../../internal/plugin/plugin_missing_test.go) cover both.
 
+A plugin added from a git repository is reinstalled by `reinstall`'s `bun update`, which re-resolves its branch or tag where `bun add` keeps the commit `bun.lock` has. Bun resolves a git spec through its own bare clone of the repository, kept in the install cache (`installCacheDir` in [`installcache.go`](../../internal/plugin/installcache.go)), and a fetch there moves `FETCH_HEAD` but not the clone's `refs/heads`, so every resolve after the first named the first install's commit again: an update of a plugin added as an unfixed `git+https://…` URL said it had installed while the plugin, `bun.lock` and the clone all stayed at the old commit, and an uninstall followed by an add again resolved it too (#2954). `refreshGitCache` ([`gitrev.go`](../../internal/plugin/gitrev.go)) now fetches the clone's branches and tags before `install`'s `bun add` (best-effort: a remote that can't be reached leaves the install to what the cache has) and before `reinstall`'s `bun update` (an error: an update that didn't happen is not reported as done); a spec that names a commit (`#<sha>`) is left alone, for nothing is resolved for one and its pin stands. When `bun update` exits 0 but the plugin is still behind the commit the checks saw the repository at, `reinstall` says so rather than claiming the update. `TestGitUpdateInstallsTheBranchsCommitNow` and `TestGitUpdateKeepsACommitPin` (on the bun on PATH, against a local `git+file://` repository) and `TestGitUpdateSaysWhenItDidnt` (with the fake bun keeping the lock's commit, as Bun's stale cache did) in [`plugin_gitupdate_test.go`](../../internal/plugin/plugin_gitupdate_test.go) cover these.
+
 A plugin the user turned off stays off through every install path: `add` keeps `Off` when it replaces an existing entry, so Add, Update, Update all and Upgrade all leave it as the user left it.
 
 ## Constraints for fixes
diff --git a/internal/plugin/gitrev.go b/internal/plugin/gitrev.go
index 23c1cb22..52196ae5 100644
--- a/internal/plugin/gitrev.go
+++ b/internal/plugin/gitrev.go
@@ -19,6 +19,7 @@ import (
 	"os"
 	"path/filepath"
 	"regexp"
+	"slices"
 	"strings"
 	"sync"
 	"time"
@@ -26,6 +27,129 @@ import (
 
 var hexSHA = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
 
+// refFixed is whether a git spec names the exact commit to install
+// (#<commit>): nothing is resolved for one, so no cache is fetched for it
+// either — the commit is in bun's clone of the repository already, and
+// the install keeps the pin whatever the clone's refs say.
+func refFixed(spec string) bool {
+	_, ref, _ := strings.Cut(spec, "#")
+	return hexSHA.MatchString(strings.ToLower(ref))
+}
+
+// gitURLs is the URLs the repository a git spec names is cloned from, the
+// spec's own first, then a shorthand's https one (github:owner/repo,
+// owner/repo, gitlab:, bitbucket:).
+func gitURLs(spec string) []string {
+	s, _, _ := strings.Cut(spec, "#")
+	s = strings.TrimPrefix(s, "git+")
+	var out []string
+	add := func(u string) {
+		u = strings.TrimSuffix(u, "/")
+		if u != "" && !slices.Contains(out, u) {
+			out = append(out, u)
+		}
+	}
+	add(s)
+	var shorthand string
+	switch {
+	case strings.HasPrefix(s, "github:"):
+		shorthand = "https://github.com/" + strings.TrimPrefix(s, "github:")
+	case strings.HasPrefix(s, "gitlab:"):
+		shorthand = "https://gitlab.com/" + strings.TrimPrefix(s, "gitlab:")
+	case strings.HasPrefix(s, "bitbucket:"):
+		shorthand = "https://bitbucket.org/" + strings.TrimPrefix(s, "bitbucket:")
+	case !strings.Contains(s, ":") && strings.Contains(s, "/"):
+		shorthand = "https://github.com/" + s
+	}
+	if shorthand != "" {
+		add(shorthand)
+	}
+	return out
+}
+
+// sameRepo is whether two URLs name one git repository: the git+ prefix,
+// the .git suffix and the letter case are nothing.
+func sameRepo(a, b string) bool {
+	trim := func(u string) string {
+		u = strings.TrimSpace(u)
+		u = strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(u, "git+"), "/"), ".git")
+		return u
+	}
+	return strings.EqualFold(trim(a), trim(b))
+}
+
+// cloneOrigin is the URL a bare clone in bun's cache was cloned from, ""
+// when its config names none: the origin remote's, else the first
+// remote's.
+func cloneOrigin(dir string) string {
+	b, err := os.ReadFile(filepath.Join(dir, "config"))
+	if err != nil {
+		return ""
+	}
+	first, atOrigin := "", false
+	for _, l := range strings.Split(string(b), "\n") {
+		l = strings.TrimSpace(l)
+		if strings.HasPrefix(l, "[") {
+			atOrigin = strings.HasPrefix(l, `[remote "origin`)
+			continue
+		}
+		if v, ok := strings.CutPrefix(l, "url"); ok {
+			v = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(v), "="))
+			if atOrigin {
+				return v
+			}
+			if first == "" {
+				first = v
+			}
+		}
+	}
+	return first
+}
+
+// fetchEach is how long a fetch into bun's cache is waited for.
+const fetchEach = time.Minute
+
+// refreshGitCache fetches the branches and tags of the repository a git
+// spec names into the clone of it bun keeps in its install cache, so
+// resolving the spec names the commit the remote is at now, not the one
+// it was at when bun cloned it first: bun fetches without moving the
+// clone's own refs, so every resolve of a branch after the first (a
+// plugin added as an unfixed git+https://… spec) found the old commit
+// again, bun.lock kept it, and an update said it had installed while
+// nothing changed (#2954). A spec pinned to a commit is left alone. With
+// no clone of the repository (bun fetches GitHub's as tarballs; a first
+// install hasn't cloned yet) there is nothing to refresh, and this is nil.
+func refreshGitCache(ctx context.Context, spec string) error {
+	if !IsGit(spec) || refFixed(spec) {
+		return nil
+	}
+	urls := gitURLs(spec)
+	es, err := os.ReadDir(installCacheDir())
+	if err != nil {
+		return nil // no cache yet: bun clones from the remote now
+	}
+	var errs []error
+	for _, e := range es {
+		if !strings.HasSuffix(e.Name(), ".git") || !e.IsDir() {
+			continue
+		}
+		dir := filepath.Join(installCacheDir(), e.Name())
+		u := cloneOrigin(dir)
+		if !slices.ContainsFunc(urls, func(want string) bool { return sameRepo(want, u) }) {
+			continue
+		}
+		fctx, cancel := context.WithTimeout(ctx, fetchEach)
+		cmd := command(fctx, "git", "-C", dir, "fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*")
+		cmd.Env = append(env(), "GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
+		out, err := cmd.CombinedOutput()
+		cancel()
+		if err != nil {
+			errs = append(errs, fmt.Errorf("fetching %s into Bun's cache: %v: %s", u, err, lastLines(string(out), 4)))
+		}
+	}
+	return errors.Join(errs...)
+}
+
 // GitCommit is the commit bun installed of the git plugin spec, as bun
 // recorded it (7 hex digits for a GitHub one, 40 for one fetched with
 // git); "" for one that isn't git, or isn't installed.
diff --git a/internal/plugin/plugin_git_test.go b/internal/plugin/plugin_git_test.go
index d16424bd..682cd449 100644
--- a/internal/plugin/plugin_git_test.go
+++ b/internal/plugin/plugin_git_test.go
@@ -129,6 +129,9 @@ func fakeBun(args []string) error {
 		}
 		deps[name], lock[name] = spec, commit
 	case "update":
+		if os.Getenv("MAGPIE_FAKE_BUN_STUCK") == "1" {
+			return nil // as bun whose cache's clone of the repository is stale: the lock's commit stays (#2954)
+		}
 		for _, n := range args[2:] {
 			if deps[n] == "" {
 				return fmt.Errorf("no dependency %s", n)
@@ -430,10 +433,7 @@ func gitPluginRest(t *testing.T, ctx context.Context, repo gitRepo, spec string,
 	}
 
 	// the same package from another URL takes the entry's place
-	file := "git+file://" + filepath.ToSlash(repo.bare)
-	if !strings.HasPrefix(file, "git+file:///") {
-		file = "git+file:///" + strings.TrimPrefix(file, "git+file://")
-	}
+	file := gitFileURL(repo.bare)
 	if _, err := Add(ctx, file); err != nil {
 		t.Fatal(err)
 	}
diff --git a/internal/plugin/plugin_gitupdate_test.go b/internal/plugin/plugin_gitupdate_test.go
new file mode 100644
index 00000000..3e8881ff
--- /dev/null
+++ b/internal/plugin/plugin_gitupdate_test.go
@@ -0,0 +1,200 @@
+package plugin
+
+import (
+	"context"
+	"os"
+	"os/exec"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+)
+
+// gitFileURL is a bare repository's git+file:// URL, as a plugin spec.
+func gitFileURL(bare string) string {
+	u := "git+file://" + filepath.ToSlash(bare)
+	if !strings.HasPrefix(u, "git+file:///") {
+		u = "git+file:///" + strings.TrimPrefix(u, "git+file://")
+	}
+	return u
+}
+
+// realBunSandbox is a HOME of the test's own where bun is the one on PATH,
+// not the fake: how bun resolves a git spec (through the clone of the
+// repository it keeps in its install cache) is the one thing the fake
+// can't stand in for.
+func realBunSandbox(t *testing.T) {
+	t.Helper()
+	if _, err := exec.LookPath("git"); err != nil {
+		t.Skip("no git on PATH")
+	}
+	bun, err := exec.LookPath("bun")
+	if err != nil {
+		t.Skip("no bun on PATH")
+	}
+	dir := t.TempDir()
+	t.Setenv("HOME", dir)
+	t.Setenv("USERPROFILE", dir)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, "cache"))
+	t.Setenv("MAGPIE_BUN", bun) // never downloaded
+	t.Cleanup(Settle)
+	forgetHeads()
+}
+
+// repoHead is the commit the repository's main is at now.
+func repoHead(t *testing.T, repo gitRepo) string {
+	t.Helper()
+	out, err := exec.Command("git", "--git-dir", repo.bare, "rev-parse", "main").Output()
+	if err != nil {
+		t.Fatal(err)
+	}
+	return strings.TrimSpace(string(out))
+}
+
+// A plugin added from a git URL that names no commit or tag stayed at the
+// commit of its first install: bun resolves the spec's branch through the
+// clone of the repository in its install cache, whose refs stay at what
+// they were when bun cloned it first, so an update (and an uninstall
+// followed by an add again) said it had installed while node_modules kept
+// the old commit (#2954). Fetched before bun resolves, the clone's refs
+// name the commit the repository is at now.
+func TestGitUpdateInstallsTheBranchsCommitNow(t *testing.T) {
+	realBunSandbox(t)
+	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
+	defer cancel()
+	repo := newGitRepo(t, filepath.Join(t.TempDir(), "repo.git"))
+	spec := gitFileURL(repo.bare)
+	if _, err := Add(ctx, spec); err != nil {
+		t.Fatal(err)
+	}
+	if v := Installed(spec); v != "1.0.0" {
+		t.Fatalf("installed %s, want 1.0.0", v)
+	}
+	repo.release("2.0.0")
+	if err := Update(ctx); err != nil {
+		t.Fatalf("update: %v", err)
+	}
+	if v := Installed(spec); v != "2.0.0" {
+		t.Fatalf("the update said it is done, the plugin is still at %s, want 2.0.0", v)
+	}
+	if c := GitCommit(spec); !SameCommit(c, repoHead(t, repo)) {
+		t.Fatalf("installed commit %s, want the repository's %s", c, repoHead(t, repo))
+	}
+
+	// an uninstall followed by an add again resolved the old commit just
+	// the same (#2954); it resolves the branch's commit now
+	repo.release("3.0.0")
+	if err := Remove(ctx, "my-oc-plugin"); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := Add(ctx, spec); err != nil {
+		t.Fatal(err)
+	}
+	if v := Installed(spec); v != "3.0.0" {
+		t.Fatalf("installed again: %s, want 3.0.0", v)
+	}
+}
+
+// An update that left the plugin at the commit it was at, though the
+// repository's check had said there was a newer one, is not reported as
+// done: bun resolving a branch through a stale cache has done exactly
+// that, and exited 0 (#2954). The fake bun stands in for that bun: its
+// update keeps the commit the lock has.
+func TestGitUpdateSaysWhenItDidnt(t *testing.T) {
+	github, _ := gitSandbox(t)
+	t.Setenv("MAGPIE_FAKE_BUN_STUCK", "1")
+	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
+	defer cancel()
+	repo := newGitRepo(t, filepath.Join(github, "owner", "repo.git"))
+	const spec = "github:owner/repo"
+	if _, err := Add(ctx, spec); err != nil {
+		t.Fatal(err)
+	}
+	repo.release("2.0.0")
+	// the page's check asked the repository and found the new commit, as
+	// it does before an update is offered
+	if h, err := GitHead(ctx, spec, true); err != nil || h == "" {
+		t.Fatalf("GitHead = %q, %v", h, err)
+	}
+	if err := Update(ctx); err == nil {
+		t.Fatal("the update said it is done, though the plugin is still at the commit it was at")
+	}
+}
+
+// A plugin whose spec names the commit to install keeps it: nothing is
+// re-resolved for one, and an update moves everything but its pin (#2954).
+func TestGitUpdateKeepsACommitPin(t *testing.T) {
+	realBunSandbox(t)
+	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
+	defer cancel()
+	repo := newGitRepo(t, filepath.Join(t.TempDir(), "repo.git"))
+	pin := repoHead(t, repo)
+	spec := gitFileURL(repo.bare) + "#" + pin
+	if _, err := Add(ctx, spec); err != nil {
+		t.Fatal(err)
+	}
+	if v := Installed(spec); v != "1.0.0" {
+		t.Fatalf("installed %s, want 1.0.0", v)
+	}
+	repo.release("2.0.0")
+	if err := Update(ctx); err != nil {
+		t.Fatalf("update: %v", err)
+	}
+	if v := Installed(spec); v != "1.0.0" {
+		t.Fatalf("a commit-pinned plugin moved to %s", v)
+	}
+	if c := GitCommit(spec); !SameCommit(c, pin) {
+		t.Fatalf("a commit-pinned plugin is at %s, want its pin %s", c, pin)
+	}
+	if b, err := os.ReadFile(filepath.Join(Dir(), "bun.lock")); err != nil || !strings.Contains(string(b), "#"+pin) {
+		t.Fatalf("bun.lock no longer pins %s: %v", pin, err)
+	}
+}
+
+func TestRefFixed(t *testing.T) {
+	for spec, want := range map[string]bool{
+		"github:owner/repo":                                                 false,
+		"github:owner/repo#main":                                            false,
+		"github:owner/repo#v1.2.0":                                          false,
+		"git+https://host/x/y.git":                                          false,
+		"git+https://host/x/y.git#semver:>=1.0":                             false,
+		"git+file:///tmp/repo.git#MAIN":                                     false,
+		"git+https://host/x/y.git#8c49a23":                                  true,
+		"git+https://host/x/y.git#8c49a230beef":                             true,
+		"git+file:///tmp/repo.git#75068205e8ef0d146deef13b1ca6cf80e6432ab0": true,
+	} {
+		if got := refFixed(spec); got != want {
+			t.Errorf("refFixed(%q) = %v, want %v", spec, got, want)
+		}
+	}
+}
+
+func TestSameRepoAndCloneOrigin(t *testing.T) {
+	for _, c := range []struct {
+		a, b string
+		want bool
+	}{
+		{"git+https://git.example.com/a/b.git", "https://git.example.com/a/b.git", true},
+		{"git+https://git.example.com/a/b", "https://git.example.com/a/b.git", true},
+		{"https://GitHub.com/a/b.git", "https://github.com/a/b", true},
+		{"git+https://git.example.com/a/b.git", "https://git.example.com/a/c.git", false},
+		{"git+file:///tmp/x/repo.git", "file:///tmp/x/repo.git", true},
+		{"", "https://git.example.com/a/b.git", false},
+	} {
+		if got := sameRepo(c.a, c.b); got != c.want {
+			t.Errorf("sameRepo(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
+		}
+	}
+	dir := t.TempDir()
+	cfg := "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://git.example.com/a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"
+	if err := os.WriteFile(filepath.Join(dir, "config"), []byte(cfg), 0o644); err != nil {
+		t.Fatal(err)
+	}
+	if got, want := cloneOrigin(dir), "https://git.example.com/a/b.git"; got != want {
+		t.Errorf("cloneOrigin = %q, want %q", got, want)
+	}
+	if got := cloneOrigin(t.TempDir()); got != "" {
+		t.Errorf("cloneOrigin of a folder with no config = %q", got)
+	}
+}
diff --git a/internal/plugin/store.go b/internal/plugin/store.go
index 8c231c4f..fa75e3f0 100644
--- a/internal/plugin/store.go
+++ b/internal/plugin/store.go
@@ -707,6 +707,13 @@ func install(ctx context.Context, spec string) error {
 		}
 	}
 	defer installMu.Unlock()
+	// the clone bun resolves a git spec through may be stale, its refs
+	// still at the first install's: fetched here so a fresh resolve (an
+	// add after a remove, a plugin installed again for being missing)
+	// names the commit the remote is at now. Best-effort: a remote that
+	// can't be reached leaves the install to what the cache has, as
+	// before (#2954)
+	_ = refreshGitCache(ctx, spec)
 	err = bunAdd(ctx, bun, spec)
 	// a @magpie-community package or version npm doesn't have (a new
 	// one waits for an owner to publish it there) comes from the
@@ -886,8 +893,9 @@ func ensurePi(ctx context.Context, target string) error {
 }
 
 // reinstall installs spec again: an npm one with bun add, a git one with
-// bun update, which fetches its branch's (or tag's) commit now where bun
-// add keeps the one bun.lock has.
+// bun update, which re-resolves its branch (or tag) where bun add keeps
+// the one bun.lock has — through bun's cache's clone of the repository,
+// whose refs refreshGitCache fetches first (#2954).
 func reinstall(ctx context.Context, spec string) error {
 	name := Name(spec)
 	if !IsGit(spec) || name == spec {
@@ -897,6 +905,13 @@ func reinstall(ctx context.Context, spec string) error {
 	if err != nil {
 		return err
 	}
+	// the update is to install what the repository is at now, which bun
+	// can only resolve through a clone whose refs are current: without
+	// the fetch it re-resolved the commit the lock already had and still
+	// said it had installed
+	if err := refreshGitCache(ctx, spec); err != nil {
+		return err
+	}
 	out, err := runBun(ctx, bun, "update", "--ignore-scripts", name)
 	if err != nil {
 		if hint := missingLibs(string(out)); hint != "" {
@@ -904,6 +919,20 @@ func reinstall(ctx context.Context, spec string) error {
 		}
 		return fmt.Errorf("bun update %s: %v: %s", name, cantStart(bun, err), lastLines(string(out), 6))
 	}
+	// what the checks saw the repository at (the page's, before the
+	// reader pressed update) is what the update was to install: bun
+	// exiting 0 has meant the old commit stayed before, and the reader is
+	// to hear so rather than be told the update is done (#2954)
+	if head := GitHeadCached(spec); head != "" && GitBehind(spec, head) {
+		// the answer stood for a while: the repository may have moved on
+		// again since, so it is asked now before this is reported
+		if now, err := GitHead(ctx, spec, true); err == nil && now != "" {
+			head = now
+		}
+		if GitBehind(spec, head) {
+			return fmt.Errorf("bun update %s left it at %s, though its repository is at %s", name, short(GitCommit(spec)), short(head))
+		}
+	}
 	return nil
 }
 
-- 
2.50.1 (Apple Git-155)


```

</details>
