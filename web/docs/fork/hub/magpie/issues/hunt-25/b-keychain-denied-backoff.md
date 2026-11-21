## 现象

#2408 报告了 Copilot CLI 的一面：用户在钥匙串授权框点了「拒绝」后，magpie 每 10 分钟再读一次 `security find-generic-password -s copilot-cli …`，授权框反复出现。同一家族里另外两个读取点没有这份退避，节奏密 60 倍：

- Cursor 的钥匙串 token（`cursor-access-token`）：`cursorTokenTTL` 是 10 秒一刀切（`internal/provider/cursor.go:347`，2e2c8903 行号，下同），被拒绝的读取和成功的读取同样只缓存 10 秒；
- Claude Code 的钥匙串项（`Claude Code-credentials`）：`claudeCacheTTL` 同样 10 秒（`internal/provider/account.go:357`），缓存不区分「读到凭据」与「读取被拒」。

也就是说：一旦某个用户的这两类钥匙串项会弹授权框（项的信任列表里没有 `/usr/bin/security` 时），点一次「拒绝」只安静 10 秒——Providers 页、Usage 轮询、网关请求路径（`cursorSignedOut`、`cursor_usage.go:48`、`claudeCredential` 的各调用方）每 10 秒触发一次新的 `security` 读取和新的弹窗。#2408 的实证（copilot 项拒绝后反复弹）证明 macOS 对每次读取都会重新弹，拒绝不被记住；重弹节奏就是 magpie 的重读节奏。

`copilotCLISecret`（`internal/provider/copilot_cli.go:169-173`）在同家族里已经做了正确的事：`denied or absent; don't ask again at once`，拒绝后 10 分钟不再问。这份处理没有到达兄弟函数。

## 最小复现

macOS 上把一个退出码 51（非 44「条目不存在」）的假 `security` 放进 PATH，它把每次调用记进日志：

- `TestDeniedCursorKeychainReadIsNotAskedAgain`（`internal/provider/keychain_denied_test.go`）：第一次 `cursorKeychainToken(false)` 拒绝；把缓存时间拨回 11 秒前（刚过旧 TTL）再读一次。修复前第二次读取再次 spawn `security`（日志 2 行）。
- `TestDeniedClaudeKeychainReadIsNotAskedAgain`：`claudeCredential()` 首次拒绝（按账号 + 按 service 各问一次，日志 2 行）；把 `claudeCacheAt` 拨回 11 秒前再读，又问 2 次（日志 4 行）。

真机弹窗节奏未人工验证（见「没跑什么」），弹窗本身的存在由 #2408 的现场报告实证。

## 根因

`internal/provider/cursor.go`（`cursorKeychainToken`）与 `internal/provider/account.go`（`claudeCredential` → `readClaudeKeychainItem`）：

- 读取失败一律按「条目不存在」处理，与成功读取共用同一个 10 秒 TTL；
- `security find-generic-password` 的退出码 44 才是条目不存在（本机实测 `security find-generic-password -s <不存在的项> -w` 退出 44，不弹窗）；其余退出码（交互被拒、授权失败等）都可能对应一次用户看到并拒绝的弹窗，这类失败却被 10 秒后重试。

## 修法

`keychainDenied(err)`：`security` 失败且退出码 ≠ 44 视为「可能弹过窗的拒绝」。这两个读取点对这类失败 10 分钟内不重复读（`keychainDeniedTTL`，对齐 `copilotCLISecret` 的家族先例）；44（条目不存在）不弹窗，保持 10 秒短 TTL，agent 侧新登录仍能在 10 秒内被发现。magpie 自己的登录/登出照旧立即重读（`forgetCursorStatus`/`forgetClaudeCredential` 清退避），`CursorToken` 的 fresh 路径不变。Copilot 自己的读取不动。

patch 同步更新 `docs/subsystems/providers-accounts.md` 的行为清单。

## 验证

| 检查 | 结果 |
|---|---|
| TestDeniedCursorKeychainReadIsNotAskedAgain @ 2e2c8903（修复前） | FAIL：`a refused read was asked again 11s later: 2 asks` |
| TestDeniedClaudeKeychainReadIsNotAskedAgain @ 2e2c8903（修复前） | FAIL：`2 asks, then 4` |
| 同两测 @ fe5a66fb（修复后） | PASS |
| go test -tags nogui -p 2 -count=1 ./internal/provider 全包 @ fe5a66fb | ok 72s |
| 消融：`git checkout fe5a66fb~1 -- account.go cursor.go` 后重放 | 两测复红，失败信息与修复前同形 |
| gofmt -l internal/provider | 空 |
| go vet -tags nogui / GOOS=linux go vet -tags nogui / GOOS=windows go vet | 过 |
| go build 三平台（linux 带 nogui） | 过（仅已知 trayimage_darwin.go cgo `-Wenum-conversion` 警告与 ld 重复库警告） |

没跑什么：

- 真实 macOS 钥匙串上人工点一次「拒绝」验证弹窗节奏——测试用假 `security` 锁重读节奏；弹窗会随每次读取重现这一点由 #2408 的现场报告实证（同一 `security` 读取机制）。
- `cursor-access-token` / `Claude Code-credentials` 条目在典型用户机器上是否弹窗（取决于各项的信任列表），未逐一台实机核实；不弹则本修无害，弹则节奏从 10 秒变 10 分钟。
- Copilot 自己的读取（`copilotCLISecret`）未改动、未重测。
- `readClaudeDir`（`internal/provider/claude_dirs.go:49`，claude-accounts 各目录的项）完全没有缓存，同一缺口更裸（每次读取都 spawn `security`），不在本 patch 范围。
- TestOffline（本机网络环境红）未跑。

同族先例：#2408（Copilot CLI 的同一机制，10 分钟节奏）。

分支：[ggbdpq/magpie `hunt25-sib-keychain-denied-backoff`](https://github.com/ggbdpq/magpie/tree/hunt25-sib-keychain-denied-backoff)，head `fe5a66fb`。

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>patch</summary>

```
From fe5a66fba9eed01784ee14f6b5744fc9b59a04ee Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:06:55 +0800
Subject: [PATCH] provider: a refused keychain read is not asked again for ten
 minutes (#2408)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: copilotCLISecret backs a denied keychain read off (10
minutes, "don't ask again at once"), but the two other readers of the
same family took every failure as an absent item and asked again after
their ordinary 10s TTL. On macOS a denied item prompts again on every
read, so a user who answers Deny once was asked again every 10 seconds
while Cursor's status or Claude's credentials were polled, and every 10
minutes only for Copilot (#2408's report is the Copilot face of this).

Now cursorKeychainToken and readClaudeKeychainItem (through
claudeCredential's cache) treat any `security` failure but 44 — the item
not being there, which asks nobody — as a read that may have shown the
user a dialog, and don't repeat it inside keychainDeniedTTL (10 minutes,
copilot's own pause). A sign-in or out in magpie reads afresh
(forgetCursorStatus, forgetClaudeCredential clear the pause), and a
fresh read in CursorToken is unchanged.

Run:
- gofmt -l internal/provider: clean.
- go test -tags nogui -p 2 -count=1 ./internal/provider: ok (72s).
- go vet -tags nogui, GOOS=linux go vet -tags nogui, GOOS=windows go
  vet, and the three go builds: see the push's checks.
- TestDeniedCursorKeychainReadIsNotAskedAgain and
  TestDeniedClaudeKeychainReadIsNotAskedAgain fail on the code before
  this (a refused read asked again 11s later).

Not tried: a real macOS keychain dialog answered no (a fake `security`
stands in for it); Copilot's own reader is unchanged.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md     |  1 +
 internal/provider/account.go              | 37 +++++++++-
 internal/provider/cursor.go               | 21 ++++--
 internal/provider/keychain_denied_test.go | 87 +++++++++++++++++++++++
 4 files changed, 141 insertions(+), 5 deletions(-)
 create mode 100644 internal/provider/keychain_denied_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index e9e5946c..0501ff55 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -172,6 +172,7 @@ readings on both sides of detected boundaries.
 - A Codex account is known by its email, with the plan for a workspace seat (`codexUser`), and a second seat of one email in another workspace by that name with its workspace after it (`codexName`): `me@example.com · Team · ws-two`. The account Codex is signed in to goes by the name it is saved under (`codexLiveName`) everywhere: its provider's `Account.User` (`codexAccount`), `liveLogin`, and its session identity (`SessionIdentities`). Its allowance, rests and sticks (`restKey`), cap, proxy, model list, a gateway key's account list (`LoginID`) and the Routing page all go by that name, so two seats of one email are never read as one (#1424).
 - Every request to the ChatGPT backend (`CodexBase`'s host) goes over HTTP/1.1, as Codex itself speaks to it: each transport [`netproxy.Dispatch`](../../internal/netproxy/netproxy.go) makes (`http.DefaultClient`'s, the gateway's) sends a request `netproxy.HTTP1` names through an HTTP/1.1 copy of itself whose TLS hello offers no h2, and the provider package sets `HTTP1` to `codexBackend` ([codex_http1.go](../../internal/provider/codex_http1.go)). That covers the gateway's turns, the models list, the warm-up, the allowance, its resets and spending one, through the proxy in force, an account's own included. Every other vendor is still offered HTTP/2.
 - The Copilot account the editors and CLI keep is read by `copilotLogin` ([account.go](../../internal/provider/account.go)): an editor's github.com sign-in in `~/.config/github-copilot/apps.json` or `hosts.json` first, then the Copilot CLI's, then an editor's on GHE.com. When GitHub refuses the editor token's trade for a session token (401 or 403, `copilotRefusals`, retried after an hour), the CLI's sign-in of the same login on the same host takes its place, sent as the CLI sends it, from that request on and on the Usage card (`copilotStandIn`); a CLI signed in to another account is never used for it, and the error names the editors' file (#1238). A sign-in from magpie of the account whose editor token is refused is kept and stands for it (`copilotProbeEditor`, `addCopilotLogin`); while the editor token works, it is let go as the agent's own, as before.
+- A keychain read that may have shown the user a dialog is not asked again for ten minutes after it was refused (`keychainDeniedTTL` in [account.go](../../internal/provider/account.go)): Copilot's token read backs a denial off (`copilotCLISecret`), and the Cursor token (`cursorKeychainToken`) and Claude Code's item (`readClaudeKeychainItem`, through `claudeCredential`'s cache) do too (#2408). 44, the item not being there, is no refusal and keeps the short TTL, so a sign-in made in the agent is still seen within it; a sign-in or out in magpie reads afresh (`forgetCursorStatus`, `forgetClaudeCredential`), backoff or not.
 - An unreadable `providers.json` is an error, never an empty list. Saving over an empty list would lose every provider.
 - When `logins.json` cannot be decoded as saved accounts, reads keep the accounts read before. Before saving a change, `lastgood.Keep` ([lastgood.go](../../internal/lastgood/lastgood.go)) keeps the file there now: as `logins.json.bak`, its last good generation, when it reads, or copied aside as `logins.json.bad-<time>` (`-2`, `-3`… for another within one second) when it doesn't, including valid JSON with invalid account field types, so its credentials can be recovered. If the existing file cannot be read or the copy fails, saving returns the error and leaves the original file unchanged. A missing file can be created normally.
 - A Windows machine that went down mid-write left `logins.json` and `plugin-auth.json` at their full length, every byte zero (#1505): the rename reached the disk before the data. Every write of magpie's own state goes through `steady.WriteFile` (or `edit.WriteAtomic`), which flushes the temp file before renaming it in, and the plugin host's `writeDurable` does the same. So does every write of an agent's own sign-in (#2239): `codexToken`'s rotated tokens into Codex's `auth.json` (`~/.codex`, or `$CODEX_HOME` when set) and `writeClaudeCredential`'s `.credentials.json` go through `writePrivate`, never a truncating `os.WriteFile`, so a machine going down mid-write leaves the old sign-in whole, and on Windows a file another program holds for a moment is waited out (`steady.Rename`) instead of the rotation being dropped while the refresh token on the disk is spent. A file that is there but doesn't read on a cold start is read from its `.bak` (`lastgood.Read`/`Fallback`): `logins.json`, `providers.json`, `migrations.json`, `settings.json`, `profiles.json`, `plugins.json`, `plugin-auth.json` and `mcp-signins.json`. `caller-keys.json` is flushed the same way but never read from a `.bak`: a key revoked in the last write would come back, so a store that doesn't read still refuses every key. The recovery is logged and listed in `/api/state`'s `recovered`, which the window tells once (`recoveredOnce`). The `.bak` lags one write behind on purpose: a crash zeroes the latest write, so a copy made with it could be zeroed too. With no good `.bak` the file is unknown, never empty: a sign-out leaves `plugin-auth.json` or `mcp-signins.json` as it is (magpie's own returns the error), and a sign-in added copies the file aside before it writes.
diff --git a/internal/provider/account.go b/internal/provider/account.go
index 9635b225..0a71a20b 100644
--- a/internal/provider/account.go
+++ b/internal/provider/account.go
@@ -22,6 +22,7 @@ import (
 	"net/http"
 	"net/url"
 	"os"
+	"os/exec"
 	"os/user"
 	"path/filepath"
 	"regexp"
@@ -350,12 +351,21 @@ var (
 	claudeCacheC   claudeCredentials
 	claudeCacheLoc claudeCredentialLocation
 	claudeCacheOK  bool
+
+	claudeAskMu sync.Mutex
+	claudeAskAt time.Time // a keychain read that may have shown a dialog
 )
 
 // claudeCacheTTL keeps All() from spawning `security` on every gateway
 // request while still noticing a fresh login quickly.
 const claudeCacheTTL = 10 * time.Second
 
+// keychainDeniedTTL is how long a keychain read that may have shown the
+// user a dialog is not asked again, as copilotCLISecret doesn't re-ask a
+// denied one at once (#723, #2408): with the item's trust list holding no
+// `security`, every ask can show the dialog again.
+const keychainDeniedTTL = 10 * time.Minute
+
 type claudeAuth struct {
 	AccessToken      string   `json:"accessToken"`
 	RefreshToken     string   `json:"refreshToken"`
@@ -489,6 +499,14 @@ type claudeKeychainItem struct {
 	hex       bool
 }
 
+// keychainDenied says whether a failed `security find-generic-password`
+// could have been a dialog the user answered no to: 44 is the item not
+// being there, which asks nobody.
+func keychainDenied(err error) bool {
+	var xe *exec.ExitError
+	return errors.As(err, &xe) && xe.ExitCode() != 44
+}
+
 // readClaudeKeychainItem reads the item for a keychain account, or by
 // service alone when the account is "". Either way it is the one under
 // $USER that a sign-in is written back to.
@@ -499,6 +517,11 @@ func readClaudeKeychainItem(account string) claudeKeychainItem {
 	}
 	out, err := proc.Command("security", args...).Output()
 	if err != nil {
+		if keychainDenied(err) {
+			claudeAskMu.Lock()
+			claudeAskAt = time.Now()
+			claudeAskMu.Unlock()
+		}
 		return claudeKeychainItem{}
 	}
 	b, wasHex := keychainText(bytes.TrimSpace(out))
@@ -560,7 +583,16 @@ func claudeCredential() (claudeCredentials, claudeCredentialLocation, bool) {
 	}
 	claudeCacheMu.Lock()
 	defer claudeCacheMu.Unlock()
-	if time.Since(claudeCacheAt) < claudeCacheTTL {
+	ttl := claudeCacheTTL
+	if !claudeCacheOK {
+		claudeAskMu.Lock()
+		ask := claudeAskAt
+		claudeAskMu.Unlock()
+		if time.Since(ask) < keychainDeniedTTL {
+			ttl = keychainDeniedTTL
+		}
+	}
+	if time.Since(claudeCacheAt) < ttl {
 		return claudeCacheC, claudeCacheLoc, claudeCacheOK
 	}
 	c, loc, ok := readClaudeCredential()
@@ -579,6 +611,9 @@ func forgetClaudeCredential() {
 	claudeCacheMu.Lock()
 	claudeCacheAt = time.Time{}
 	claudeCacheMu.Unlock()
+	claudeAskMu.Lock()
+	claudeAskAt = time.Time{}
+	claudeAskMu.Unlock()
 }
 
 func saveClaudeCredential(loc claudeCredentialLocation, c claudeCredentials) error {
diff --git a/internal/provider/cursor.go b/internal/provider/cursor.go
index cf35b5ea..a7a68498 100644
--- a/internal/provider/cursor.go
+++ b/internal/provider/cursor.go
@@ -73,7 +73,7 @@ func cursorIdentity() (user, plan string, ok bool) {
 func forgetCursorStatus() {
 	cursorStatus.forget()
 	cursorTok.Lock()
-	cursorTok.at = time.Time{}
+	cursorTok.at, cursorTok.ask = time.Time{}, time.Time{}
 	cursorTok.Unlock()
 }
 
@@ -334,11 +334,14 @@ func cursorAuthFile() string {
 
 // cursorTok is the token cursor-agent keeps in the Keychain as last read,
 // and when: every look at whether Cursor is signed in ran `security`, a
-// plugin's accounts for each build of the providers (#746).
+// plugin's accounts for each build of the providers (#746). ask is when a
+// read could have shown the user a dialog: one the user answered no to is
+// not asked again inside keychainDeniedTTL (#2408).
 var cursorTok struct {
 	sync.Mutex
 	tok string
 	at  time.Time
+	ask time.Time
 }
 
 // cursorTokenTTL is how long a token read from the Keychain is taken as
@@ -354,13 +357,23 @@ func cursorKeychainToken(fresh bool) string {
 	}
 	cursorTok.Lock()
 	defer cursorTok.Unlock()
-	if !fresh && time.Since(cursorTok.at) < cursorTokenTTL {
+	ttl := cursorTokenTTL
+	if cursorTok.tok == "" && time.Since(cursorTok.ask) < keychainDeniedTTL {
+		ttl = keychainDeniedTTL
+	}
+	if !fresh && time.Since(cursorTok.at) < ttl {
 		return cursorTok.tok
 	}
 	out, err := proc.Command("security", "find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w").Output()
 	cursorTok.tok, cursorTok.at = "", time.Now()
-	if err == nil {
+	switch {
+	case err == nil:
 		cursorTok.tok = strings.TrimSpace(string(out))
+		cursorTok.ask = time.Time{}
+	case keychainDenied(err):
+		cursorTok.ask = cursorTok.at
+	default:
+		cursorTok.ask = time.Time{}
 	}
 	return cursorTok.tok
 }
diff --git a/internal/provider/keychain_denied_test.go b/internal/provider/keychain_denied_test.go
new file mode 100644
index 00000000..0a356be8
--- /dev/null
+++ b/internal/provider/keychain_denied_test.go
@@ -0,0 +1,87 @@
+package provider
+
+// A keychain read that can have shown the user a dialog and was refused is
+// not asked again every poll: copilotCLISecret backs one off, and so do
+// the Cursor and Claude Code readers (#2408). A fake `security` answers
+// the way a refused read does (51, not 44, the item not being there), and
+// logs each ask; the reader may reach it once, and then not again inside
+// the denial's pause.
+
+import (
+	"bytes"
+	"os"
+	"path/filepath"
+	"runtime"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+func fakeSecurityDenied(t *testing.T) func() int {
+	t.Helper()
+	dir := t.TempDir()
+	log := filepath.Join(dir, "asked.log")
+	testenv.Program(t, filepath.Join(dir, "security"), "#!/bin/sh\necho \"$*\" >> "+log+"\nexit 51\n")
+	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
+	return func() int {
+		b, _ := os.ReadFile(log)
+		return bytes.Count(b, []byte("\n"))
+	}
+}
+
+func TestDeniedCursorKeychainReadIsNotAskedAgain(t *testing.T) {
+	if runtime.GOOS != "darwin" {
+		t.Skip("the Cursor keychain read is a macOS one")
+	}
+	signIn(t)
+	asks := fakeSecurityDenied(t)
+	cursorTok.Lock()
+	cursorTok.tok, cursorTok.at = "", time.Time{}
+	cursorTok.Unlock()
+	if tok := cursorKeychainToken(false); tok != "" {
+		t.Fatalf("a refused read is no token: %q", tok)
+	}
+	if n := asks(); n != 1 {
+		t.Fatalf("the first read asks the keychain once, asked %d times", n)
+	}
+	// past the 10s token TTL, still inside the denial's pause: not asked again
+	cursorTok.Lock()
+	cursorTok.at = time.Now().Add(-11 * time.Second)
+	cursorTok.Unlock()
+	if tok := cursorKeychainToken(false); tok != "" {
+		t.Fatalf("a refused read is no token: %q", tok)
+	}
+	if n := asks(); n != 1 {
+		t.Fatalf("a refused read was asked again 11s later: %d asks", n)
+	}
+}
+
+func TestDeniedClaudeKeychainReadIsNotAskedAgain(t *testing.T) {
+	if runtime.GOOS != "darwin" {
+		t.Skip("the Claude keychain read is a macOS one")
+	}
+	signIn(t)
+	asks := fakeSecurityDenied(t)
+	oldKeychain := claudeKeychain
+	claudeKeychain = true
+	defer func() { claudeKeychain = oldKeychain }()
+	forgetClaudeCredential()
+	if _, _, ok := claudeCredential(); ok {
+		t.Fatal("a refused read is no sign-in")
+	}
+	n := asks()
+	if n == 0 {
+		t.Fatal("the read never reached the keychain")
+	}
+	// past the 10s cache, still inside the denial's pause: not asked again
+	claudeCacheMu.Lock()
+	claudeCacheAt = time.Now().Add(-11 * time.Second)
+	claudeCacheMu.Unlock()
+	if _, _, ok := claudeCredential(); ok {
+		t.Fatal("a refused read is no sign-in")
+	}
+	if got := asks(); got != n {
+		t.Fatalf("a refused read was asked again 11s later: %d asks, then %d", n, got)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```

</details>
