**Summary**: `magpie plugin login` gave a plugin's browser sign-in its own 10 minutes and, when they ran out, handed the user a bare `magpie: context deadline exceeded` — nothing saying the sign-in timed out, nothing saying to start again. The window's sign-in waits on `signInTimeout` and says "the sign-in timed out; start it again". This makes the command line wait on that same clock and say the same thing. It takes the report's items (2) and (3); item (1) — a `timeout` field on `Authorization`, so a plugin that knows its flow is slow can ask for its own budget — is the plugin API's to decide and is left to a change of its own. The ten-minute default itself stays as it is.

**Cause**: the host's sign-in clock is `var signInTimeout = 10 * time.Minute` (`internal/provider/signin.go:48`). The window's entry waits on it (`internal/provider/pluginsignin.go:126`) and `pluginDone` turns `context.DeadlineExceeded` into "the sign-in timed out; start it again" (`internal/provider/pluginsignin.go:202-203`). The command line's entry did neither: `internal/cli/plugins_cli.go:499` built its own `context.WithTimeout(ctx, 10*time.Minute)`, and the error `plugin.Finish` returns at the deadline — `ctx.Err()` verbatim (`internal/plugin/host.go:1465-1467`) — reached the user through the plain print at `internal/cli/main.go:201`.

**Fix**:
- `provider.SignInTimeout()` (`internal/provider/signin.go`) is how other packages read the sign-in's clock; `magpie plugin login` waits on it now instead of its own literal (`internal/cli/plugins_cli.go:498`), so the two entrances run on one clock and a change to the window's waits on the command line too. The `time` import went with the literal — it was that literal's only use.
- When `plugin.Finish` ends in `context.DeadlineExceeded`, the CLI says "the sign-in timed out; start it again" — the window's words (`internal/cli/plugins_cli.go:521-525`). Every other error, the plugin's own included, still reaches the user as it came; a test pins that ("the sign-in page expired" passes through untouched).
- The test's slow sign-in is a new held-open branch in the test plugin (`code === "wait"` returns a promise that never settles, `internal/plugin/testdata/fake/index.js`), driven against a 5-second context — the same `context.DeadlineExceeded` the real ten-minute wait produces, without waiting ten minutes.

**Verification** (base `c922225f`, macOS arm64, Go 1.26.8):
| Check | Command | Result |
|---|---|---|
| New test, fix reverted, test kept | `go test ./internal/cli -run TestPluginLoginSaysTimedOut -count=1` | FAIL — the deadline reached the user (assertion below) |
| New test, with the fix | same | ok (5.08s) |
| Guard: a plugin's own error passes through | `go test ./internal/cli -run TestPluginLoginKeepsAPluginErrorAsItCame -count=1` | ok |
| cli package | `go test ./internal/cli/... -count=1` | ok (48.3s) |
| plugin package (its testdata gained the held-open sign-in) | `go test ./internal/plugin/... -count=1` | ok (70.2s) |
| provider package | `go test ./internal/provider/... -count=1` | ok (85.7s) |
| Race | `go test ./internal/cli -run TestPluginLogin -count=1 -race` | ok |
| Format | `gofmt -l internal/cli internal/provider` | clean |
| Vet | `go vet ./internal/cli/... ./internal/provider/...` | clean |
| Build | `GOOS=darwin GOARCH=arm64 go build .`; `GOOS=linux GOARCH=amd64 go build -tags nogui .`; `GOOS=windows GOARCH=amd64 go build .` | all ok |

**Not verified**: a real qoder sign-in that outlasts ten minutes — the timing here is the fake plugin's held-open callback against a 5-second context; the error at the deadline is the same `context.DeadlineExceeded` the real wait returns, but no real 15-minute OAuth flow was run. Nor the browser round-trip of any vendor's flow: the sign-ins here end at a fake plugin.

---
**Source**: reported in #3083 (asuan-dev, with a real reproduction against the qoder plugin); this takes the report's items (2) and (3); item (1), a `timeout` field on `Authorization`, is the plugin API's to decide and is left here.

**Red without the fix** (base `c922225f`): with the fix reverted and the new test kept, `go test ./internal/cli -run TestPluginLoginSaysTimedOut` fails:
```
    plugin_login_cli_test.go:116: the clock ran out and magpie said "context deadline exceeded"; want it timed out
--- FAIL: TestPluginLoginSaysTimedOut (5.08s)
FAIL
FAIL	github.com/yetone/magpie/internal/cli	5.532s
```
With the fix: `ok`.

**Siblings**: `internal/mcpauth/mcpauth.go:64` keeps its own `signInTimeout = 10 * time.Minute` for the MCP browser flow; its expiry already says the same words (`internal/mcpauth/mcpauth.go:927`), so only the duplicated constant is left to unify — Left here, a separate package and not named in the issue. Built-in sign-ins (`magpie accounts add`) never leak a bare deadline: the provider's own watcher ends them with the same words (`internal/provider/signin.go:275`) and `WaitSignIn` hands that text to the CLI. Other `10 * time.Minute` literals are different clocks, not a browser sign-in's — self-update (`internal/cli/update_cli.go:155`), the window's update (`internal/gui/update.go:280`) and provider move (`internal/gui/providers.go:986`), CLI installs (`internal/provider/install.go:67`), and renewal bookkeeping (`codex_warmup.go`, `logins.go`, `partners.go`, `migrate.go`, `quota_alert.go`, `account.go`, `copilot_cli.go`, `codex_autoreset.go`) — untouched.

**When the read fails**: if the patch block below is mangled by the issue renderer, the same commit sits on branch `hunt54-d-signin-timeout` (head `f21de209`) — cherry-pick it, or `git am` the raw `0001-*.patch` file from that branch.

**Not verified**: a real qoder sign-in that outlasts ten minutes (the report's reproduction); the browser round-trip of any vendor's real OAuth flow.

Branch with the commit: [hunt54-d-signin-timeout](https://github.com/ggbdpq/magpie/tree/hunt54-d-signin-timeout) (head `f21de209`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: cli: a plugin sign-in that runs out says so, on the same clock the window waits on (#3083) — git am applies it as is; SHA-256 first 16: aa4b023ef0470150</summary>

```patch
From f21de209e2727b6a557c1362f826ddebbe596df7 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 05:11:22 +0800
Subject: [PATCH] cli: a plugin sign-in that runs out says so, on the same
 clock the window waits on (#3083)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

`magpie plugin login` gave its sign-in its own 10 minutes rather than
the window's `signInTimeout`, and let the deadline surface as it came:
a browser sign-in slower than that ended in a bare
"magpie: context deadline exceeded", nothing saying the sign-in timed
out or to start it again — while the window's sign-in, waiting on
`signInTimeout` and turning `context.DeadlineExceeded` away in
`pluginDone`, says "the sign-in timed out; start it again".

The command line now waits on `provider.SignInTimeout()` — the same
clock — and says the same thing when it runs out. Every other error
still reaches the user as the plugin said it.

Run: with the fake plugin's sign-in held open (a code whose callback
never finishes) and the wait given 5s, the new test red on base
(plugin_login_cli_test.go:116, magpie said "context deadline
exceeded"), green with the fix, red again with the fix reverted and
the test kept. A plugin's own error ("the sign-in page expired")
still comes through as it came. go test ./internal/cli/... ok;
./internal/plugin/... ok; ./internal/provider/... ok; -race on
TestPluginLogin ok; gofmt -l clean; go vet clean; builds on
darwin/arm64, linux/amd64 (-tags nogui) and windows/amd64.

Fixes #3083

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/cli/plugin_login_cli_test.go  | 37 ++++++++++++++++++++++++++
 internal/cli/plugins_cli.go            |  8 ++++--
 internal/plugin/testdata/fake/index.js |  4 ++-
 internal/provider/signin.go            |  5 ++++
 4 files changed, 51 insertions(+), 3 deletions(-)

diff --git a/internal/cli/plugin_login_cli_test.go b/internal/cli/plugin_login_cli_test.go
index 94157231..952fadcd 100644
--- a/internal/cli/plugin_login_cli_test.go
+++ b/internal/cli/plugin_login_cli_test.go
@@ -6,6 +6,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"path/filepath"
+	"strings"
 	"sync/atomic"
 	"testing"
 	"time"
@@ -97,6 +98,42 @@ func TestPluginLoginReadsUsageAfresh(t *testing.T) {
 	}
 }
 
+// magpie plugin login, out of time while the plugin still waits for its
+// browser sign-in, says so the way the window's sign-in does, rather than
+// letting the deadline reach the user as a bare "context deadline
+// exceeded" (#3083).
+func TestPluginLoginSaysTimedOut(t *testing.T) {
+	ctx := fakeCoHome(t)
+	noBrowser(t)
+	// the browser's way (2), Home (1), and a code whose sign-in the plugin
+	// never finishes: the sign-in's clock runs out first
+	piped(t, "1", "wait")
+	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
+	defer cancel()
+	if _, err := said(t, func() error { return pluginLogin(wait, "fakeco", "2") }); err == nil {
+		t.Fatal("a sign-in past its time ended in nothing")
+	} else if !strings.Contains(err.Error(), "timed out") {
+		t.Fatalf("the clock ran out and magpie said %q; want it timed out", err)
+	} else if strings.Contains(err.Error(), "context deadline") {
+		t.Fatalf("the deadline itself reached the user: %q", err)
+	}
+}
+
+// An error of the plugin's own, not the clock's, reaches the user as it
+// came: the sign-in's words are for timeouts alone.
+func TestPluginLoginKeepsAPluginErrorAsItCame(t *testing.T) {
+	ctx := fakeCoHome(t)
+	noBrowser(t)
+	// the browser's way (2), Home (1), and the code the page shows, which
+	// its page says has expired
+	piped(t, "1", "expired")
+	if _, err := said(t, func() error { return pluginLogin(ctx, "fakeco", "2") }); err == nil {
+		t.Fatal("an expired code signed in")
+	} else if !strings.Contains(err.Error(), "the sign-in page expired") {
+		t.Fatalf("the plugin's own error was rewritten: %q", err)
+	}
+}
+
 // fakeCoHome is a HOME of the test's own with the plugin host's test
 // plugin (FakeCo) added, as TestAccountsOfAPlugin sets one up.
 func fakeCoHome(t *testing.T) context.Context {
diff --git a/internal/cli/plugins_cli.go b/internal/cli/plugins_cli.go
index af0cc8e1..5c1b8fa6 100644
--- a/internal/cli/plugins_cli.go
+++ b/internal/cli/plugins_cli.go
@@ -9,7 +9,6 @@ import (
 	"sort"
 	"strconv"
 	"strings"
-	"time"
 
 	"github.com/yetone/magpie/internal/gateway"
 	"github.com/yetone/magpie/internal/middleware"
@@ -496,7 +495,7 @@ func pluginLogin(ctx context.Context, name, method string) error {
 			}
 			code = strings.TrimSpace(line)
 		}
-		wait, cancel := context.WithTimeout(ctx, 10*time.Minute)
+		wait, cancel := context.WithTimeout(ctx, provider.SignInTimeout())
 		defer cancel()
 		if a.Method != "code" && provider.PluginPastesCallback(pp.ID, a.URL) {
 			// a browser on another computer (magpie on a server or in
@@ -520,6 +519,11 @@ func pluginLogin(ctx context.Context, name, method string) error {
 			}()
 		}
 		if saved, err = plugin.Finish(wait, a.Session, code); err != nil {
+			if errors.Is(err, context.DeadlineExceeded) {
+				// the sign-in ran out of time, as the window's says when
+				// its does: the deadline itself is no words for a user
+				err = errors.New("the sign-in timed out; start it again")
+			}
 			return err
 		}
 	}
diff --git a/internal/plugin/testdata/fake/index.js b/internal/plugin/testdata/fake/index.js
index dc83d038..6ff5e960 100644
--- a/internal/plugin/testdata/fake/index.js
+++ b/internal/plugin/testdata/fake/index.js
@@ -142,7 +142,9 @@ export const FakePlugin = async ({ client }) => ({
           // `grok login` opens its own on macOS and Windows
           opened: inputs.team === "cli-opened",
           callback: async (code) =>
-            (process.env.FAKE_SIGNIN && (await fetch(process.env.FAKE_SIGNIN + "/token").catch(() => {})), code === "good")
+            code === "wait"
+              ? new Promise(() => {}) // a sign-in that never finishes, for a sign-in that runs out of time first
+              : (process.env.FAKE_SIGNIN && (await fetch(process.env.FAKE_SIGNIN + "/token").catch(() => {})), code === "good")
               ? { type: "success", refresh: "r-" + (inputs.team ?? "none"), access: "stale", expires: 0, ...fakeWho(inputs.team) }
               : code === "expired"
                 ? { type: "failed", error: "the sign-in page expired" }
diff --git a/internal/provider/signin.go b/internal/provider/signin.go
index 7b6acfec..57092faf 100644
--- a/internal/provider/signin.go
+++ b/internal/provider/signin.go
@@ -47,6 +47,11 @@ const codexScopes = "openid profile email offline_access api.connectors.read api
 // signInTimeout is how long a sign-in waits for the browser.
 var signInTimeout = 10 * time.Minute
 
+// SignInTimeout is how long a sign-in waits for the browser: the command
+// line's plugin sign-in waits on the same clock the window's does, and
+// says the same thing when it runs out.
+func SignInTimeout() time.Duration { return signInTimeout }
+
 // devicePollFloor is the least a device sign-in (Copilot, Factory, ZCode)
 // waits between asking whether the user is done, whatever interval the
 // vendor gave, 0 among them. A var: the tests' fakes give 0, and a second
-- 
2.50.1 (Apple Git-155)

```

</details>
