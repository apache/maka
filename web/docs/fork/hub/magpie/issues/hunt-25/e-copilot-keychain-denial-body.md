接单修复，补丁在本机完成并验证通过，分支与 patch 见文末。

## 现象

报告者卸载 Copilot CLI 后，magpie 反复拉起 `security find-generic-password -s copilot-cli -a <账号> -w`（报告者的 ps 证据里这条命令与 `internal/provider/copilot_cli.go` 的 darwin 分支逐字一致，PPID 就是 magpie）。对弹出的 Keychain 授权框点 **Deny** 之后，弹窗仍会一遍遍回来——间隔约 10 分钟，只要 magpie 开着就无限循环。

## 最小复现（单元级）

前提：`~/.copilot/config.json` 还留着 `loggedInUsers`/`lastLoggedInUser`（卸载 CLI 不会删这个目录，#1495 已定性这是 agent 自己的文件、保持 discovered），且该账号在 `copilotTokens` 里没有明文 token。

1. magpie 列出订阅账号（`Accounts()`，GUI 的常规轮询就会走到），`copilotCLILoginIn` 找到账号、无明文 token → 调 `copilotCLISecret`；
2. darwin 上 spawn `security find-generic-password`，magpie 不在该 Keychain 项的 ACL 里 → 系统弹授权框；
3. 用户 Deny → 读失败 → 旧代码把它当作"没读到"缓存 10 分钟；
4. 10 分钟后下一次账号列表再走 1-3，弹窗回来。循环不终止。

红测试把这个循环钉住了：假 `security` 以 51 退出（模拟被拒的授权框），第一次读运行 1 次；把缓存时间拨过 10 分钟再读，旧代码又运行了一次 security——这正是"Deny 之后弹窗回来"的根源。

## 根因

`internal/provider/copilot_cli.go`（修复前）：

```go
out, _ = proc.Command("security", "find-generic-password", "-s", "copilot-cli", "-a", account, "-w").Output()
...
ttl = 10 * time.Minute // denied or absent; don't ask again at once
```

错误被整个丢弃，"用户看着弹窗点了拒绝"和"keychain 里根本没有这一项"共用同一个 10 分钟退避。前者每一次重试都会把对话框放回用户面前，后者从不弹任何东西。

## 修法

按退出码把两种失败分开（只动 darwin 分支，Linux/Windows 行为不变）：

- **退出码 44**（条目不存在；本机 macOS 实测 `security find-generic-password -s <不存在的项> -w` → exit 44、无任何 UI）：保留原 10 分钟重试，之后在 CLI 里新登录的账号仍能被及时发现；
- **其余失败**（要么是用户刚拒绝的授权框，要么是打不开的 keychain——重读只会把同一界面再放出来）：该账号本轮不再读，**重启 magpie 即是显式重试**（与报告者期望一致：Deny 生效、重试需用户动作）。

实现上把真实现从匿名 var 提为具名函数 `copilotCLISecretReal`（`copilotCLISecret` 仍指向它），测试才能占位再还原；`docs/subsystems/providers-accounts.md` 的 Copilot 段补了这句行为。

发现（discovery）的总开关、对残留凭据的 discovered 语义都不动——#1495 维护者已定性残留的 `~/.copilot` 是 agent 自己的文件，本修只尊重用户对具体 Keychain 项说过的"不"。

## 验证

| 检查 | 结果 |
|---|---|
| 修前红（2e2c8903 + 测试桥接副本） | `TestCopilotCLISecretDeniedNotAskedAgain`: `security ran 2 times after a denial, want still 1` |
| 修后绿 | 同测试 ok；`TestCopilotCLISecretAbsentRetriedAfterTheWait`（44 仍按 10 分钟重试的对照组）新旧树都 ok |
| 全包 | `go test -tags nogui -p 2 -count=1 ./internal/provider/` ok（74.8s） |
| 消融 | `git checkout 630cdb86~1 -- internal/provider/copilot_cli.go` 后红测试以同一断言复红，回置修复转绿 |
| gofmt | `gofmt -l internal/` 干净 |
| vet | `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` 干净（`trayimage_darwin.go` 的 cgo `-Wenum-conversion` 警告为已知环境噪声） |
| build | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 三平台 `go build` ok |

**没跑什么（如实）**：没在真实 GUI 里走完一次 Deny 对话框——弹窗无法自动化点击；修法刻意不依赖 Deny 的精确退出码（非 44 即按"用户见过的失败"处理），44 的无 UI 路径在本机实测。Linux `secret-tool` 的拒绝语义未验证（本修不改 Linux 行为）。Windows 无 keychain 读，未测。cursor 的 `cursor-access-token` 读（10s TTL，同样无拒绝追踪）是同族面，但无报告、且挂着 fresh 语义，本修不碰，留作后续判断。

<details><summary>patch</summary>

```diff
From 630cdb86e88003cd06cd7a87cc681396910fa28a Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:02:53 +0800
Subject: [PATCH] provider: a Copilot CLI keychain read the user watched fail
 is not asked again until magpie restarts (#2408)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: copilotCLISecret discarded the error of its
`security find-generic-password` run, so a denied access prompt and an
item simply missing shared one ten-minute backoff, and a leftover
~/.copilot/config.json kept bringing the Keychain dialog back every ten
minutes after the user had said no (#2408). The read now tells the two
apart by the exit: 44 is the item not being in the keychain, which
showed nothing, and keeps the short retry so a sign-in made later is
found; any other failure ended a prompt the user saw, and that account
is not read again this run — restarting magpie is the explicit way to
ask once more. The real read is named (copilotCLISecretReal) so tests
can stand their own in and put it back; TestCopilotCLISecretDeniedNot-
AskedAgain fails on the old code, TestCopilotCLISecretAbsentRetriedAfter
TheWait pins the absent case. The providers doc names the new behavior.

Run: go test -tags nogui -p 2 -count=1 ./internal/provider/ (ok, 75s);
gofmt -l internal/provider/ clean; the red first on 2e2c8903 with the
test's bridge copy of the named read: "security ran 2 times after a
denial, want still 1". vet and the three builds pending before push.
Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md |  2 +-
 internal/provider/copilot_cli.go      | 47 ++++++++++++---
 internal/provider/copilot_cli_test.go | 84 +++++++++++++++++++++++++++
 3 files changed, 125 insertions(+), 8 deletions(-)

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index e9e5946c..c652b987 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -171,7 +171,7 @@ readings on both sides of detected boundaries.
 - A Copilot account is known by its GitHub login and host (`CopilotAccountName`, #1220): `mona` on github.com, `mona@acme.ghe.com` on an enterprise's GHE.com. That name is its `logins.json` user, its row in every list, its usage card and its per-account routing settings, and it is what `SwitchLogin`, `SetLoginOn` and `ForgetLogin` take, so one login on two hosts is two accounts, neither written over by the other nor dropped as the editors' own. One saved before on an enterprise's host under its login alone is read under its name with the host (`copilotSavedName`), keeping its id; the editors' own remembered so is renamed in place, still hidden if it was (`copilotRenamed`). Either rename takes the account's per-account settings in `providers.json` (proxy, models, cap, concurrency) from the bare login to the new name before the new name is written to `logins.json` (`renameSettled`): a setting the new name has already stays, and while `providers.json` can't be read or written the account stays saved under its old name, its settings with it. `magpie accounts switch|forget copilot` takes the full name, the login with `--host <name>.ghe.com`, or the login alone when it names one account.
 - A Codex account is known by its email, with the plan for a workspace seat (`codexUser`), and a second seat of one email in another workspace by that name with its workspace after it (`codexName`): `me@example.com · Team · ws-two`. The account Codex is signed in to goes by the name it is saved under (`codexLiveName`) everywhere: its provider's `Account.User` (`codexAccount`), `liveLogin`, and its session identity (`SessionIdentities`). Its allowance, rests and sticks (`restKey`), cap, proxy, model list, a gateway key's account list (`LoginID`) and the Routing page all go by that name, so two seats of one email are never read as one (#1424).
 - Every request to the ChatGPT backend (`CodexBase`'s host) goes over HTTP/1.1, as Codex itself speaks to it: each transport [`netproxy.Dispatch`](../../internal/netproxy/netproxy.go) makes (`http.DefaultClient`'s, the gateway's) sends a request `netproxy.HTTP1` names through an HTTP/1.1 copy of itself whose TLS hello offers no h2, and the provider package sets `HTTP1` to `codexBackend` ([codex_http1.go](../../internal/provider/codex_http1.go)). That covers the gateway's turns, the models list, the warm-up, the allowance, its resets and spending one, through the proxy in force, an account's own included. Every other vendor is still offered HTTP/2.
-- The Copilot account the editors and CLI keep is read by `copilotLogin` ([account.go](../../internal/provider/account.go)): an editor's github.com sign-in in `~/.config/github-copilot/apps.json` or `hosts.json` first, then the Copilot CLI's, then an editor's on GHE.com. When GitHub refuses the editor token's trade for a session token (401 or 403, `copilotRefusals`, retried after an hour), the CLI's sign-in of the same login on the same host takes its place, sent as the CLI sends it, from that request on and on the Usage card (`copilotStandIn`); a CLI signed in to another account is never used for it, and the error names the editors' file (#1238). A sign-in from magpie of the account whose editor token is refused is kept and stands for it (`copilotProbeEditor`, `addCopilotLogin`); while the editor token works, it is let go as the agent's own, as before.
+- The Copilot account the editors and CLI keep is read by `copilotLogin` ([account.go](../../internal/provider/account.go)): an editor's github.com sign-in in `~/.config/github-copilot/apps.json` or `hosts.json` first, then the Copilot CLI's, then an editor's on GHE.com. When GitHub refuses the editor token's trade for a session token (401 or 403, `copilotRefusals`, retried after an hour), the CLI's sign-in of the same login on the same host takes its place, sent as the CLI sends it, from that request on and on the Usage card (`copilotStandIn`); a CLI signed in to another account is never used for it, and the error names the editors' file (#1238). A sign-in from magpie of the account whose editor token is refused is kept and stands for it (`copilotProbeEditor`, `addCopilotLogin`); while the editor token works, it is let go as the agent's own, as before. On macOS the CLI's token is read from the Keychain's `copilot-cli` item at most once an hour, and once a read there has ended in an access prompt the user denied, that account isn't read again until magpie restarts (#2408); an item that isn't there (exit 44, nothing on screen) is retried after ten minutes, so a sign-in made later is found.
 - An unreadable `providers.json` is an error, never an empty list. Saving over an empty list would lose every provider.
 - When `logins.json` cannot be decoded as saved accounts, reads keep the accounts read before. Before saving a change, `lastgood.Keep` ([lastgood.go](../../internal/lastgood/lastgood.go)) keeps the file there now: as `logins.json.bak`, its last good generation, when it reads, or copied aside as `logins.json.bad-<time>` (`-2`, `-3`… for another within one second) when it doesn't, including valid JSON with invalid account field types, so its credentials can be recovered. If the existing file cannot be read or the copy fails, saving returns the error and leaves the original file unchanged. A missing file can be created normally.
 - A Windows machine that went down mid-write left `logins.json` and `plugin-auth.json` at their full length, every byte zero (#1505): the rename reached the disk before the data. Every write of magpie's own state goes through `steady.WriteFile` (or `edit.WriteAtomic`), which flushes the temp file before renaming it in, and the plugin host's `writeDurable` does the same. So does every write of an agent's own sign-in (#2239): `codexToken`'s rotated tokens into Codex's `auth.json` (`~/.codex`, or `$CODEX_HOME` when set) and `writeClaudeCredential`'s `.credentials.json` go through `writePrivate`, never a truncating `os.WriteFile`, so a machine going down mid-write leaves the old sign-in whole, and on Windows a file another program holds for a moment is waited out (`steady.Rename`) instead of the rotation being dropped while the refresh token on the disk is spent. A file that is there but doesn't read on a cold start is read from its `.bak` (`lastgood.Read`/`Fallback`): `logins.json`, `providers.json`, `migrations.json`, `settings.json`, `profiles.json`, `plugins.json`, `plugin-auth.json` and `mcp-signins.json`. `caller-keys.json` is flushed the same way but never read from a `.bak`: a key revoked in the last write would come back, so a store that doesn't read still refuses every key. The recovery is logged and listed in `/api/state`'s `recovered`, which the window tells once (`recoveredOnce`). The `.bak` lags one write behind on purpose: a crash zeroes the latest write, so a copy made with it could be zeroed too. With no good `.bak` the file is unknown, never empty: a sign-out leaves `plugin-auth.json` or `mcp-signins.json` as it is (magpie's own returns the error), and a sign-in added copies the file aside before it writes.
diff --git a/internal/provider/copilot_cli.go b/internal/provider/copilot_cli.go
index 4531c621..8bf344ec 100644
--- a/internal/provider/copilot_cli.go
+++ b/internal/provider/copilot_cli.go
@@ -150,13 +150,20 @@ func copilotCLILoginIn(dir string, secret func(string) string) (copilotApp, bool
 
 var copilotSecrets struct {
 	sync.Mutex
-	at  map[string]time.Time
-	tok map[string]string
+	at      map[string]time.Time
+	tok     map[string]string
+	stopped map[string]bool
 }
 
 // copilotCLISecret reads the CLI's token from the keychain, once in a
-// while: each read may ask the user to allow it.
-var copilotCLISecret = func(account string) string {
+// while: each read may ask the user to allow it. A read the user watched
+// fail — the access prompt denied — is not asked again until magpie
+// restarts (#2408).
+var copilotCLISecret = copilotCLISecretReal
+
+// copilotCLISecretReal is the read copilotCLISecret stands for; a named
+// function so tests can put their own in its place and put it back.
+func copilotCLISecretReal(account string) string {
 	if settings.AccountDiscoveryOff() {
 		return ""
 	}
@@ -165,27 +172,53 @@ var copilotCLISecret = func(account string) string {
 	defer c.Unlock()
 	if c.at == nil {
 		c.at, c.tok = map[string]time.Time{}, map[string]string{}
+		c.stopped = map[string]bool{}
+	}
+	if c.stopped[account] {
+		return ""
 	}
 	ttl := time.Hour
 	if c.tok[account] == "" {
-		ttl = 10 * time.Minute // denied or absent; don't ask again at once
+		ttl = 10 * time.Minute // absent; don't ask again at once
 	}
 	if at, ok := c.at[account]; ok && time.Since(at) < ttl {
 		return c.tok[account]
 	}
 	var out []byte
+	var err error
 	switch runtime.GOOS {
 	case "darwin":
-		out, _ = proc.Command("security", "find-generic-password", "-s", "copilot-cli", "-a", account, "-w").Output()
+		out, err = proc.Command("security", "find-generic-password", "-s", "copilot-cli", "-a", account, "-w").Output()
 	case "linux":
-		if p, err := exec.LookPath("secret-tool"); err == nil {
+		if p, lookErr := exec.LookPath("secret-tool"); lookErr == nil {
 			out = []byte(copilotSecretTool(p, account))
 		}
 	}
 	c.at[account], c.tok[account] = time.Now(), string(bytes.TrimSpace(out))
+	if keychainRefused(err) {
+		c.stopped[account] = true
+	}
 	return c.tok[account]
 }
 
+// keychainRefused says a failed keychain read ended in something the user
+// was shown. On macOS, `security` exits 44 when the item isn't in the
+// keychain at all, which puts nothing on screen (measured), so its short
+// retry stays; any other failure is an access prompt the user denied or a
+// keychain that won't answer on its own, and reading that account again
+// would put the prompt back in front of a sign-in they already said no to
+// (#2408). With no `security` to run there is nothing to retry either.
+func keychainRefused(err error) bool {
+	if err == nil {
+		return false
+	}
+	var ee *exec.ExitError
+	if errors.As(err, &ee) {
+		return ee.ExitCode() != 44
+	}
+	return true
+}
+
 // copilotSecretWait bounds one secret-tool lookup: a keyring that waits on
 // a prompt nobody answers would hold the sign-in that asked (#723).
 var copilotSecretWait = 5 * time.Second
diff --git a/internal/provider/copilot_cli_test.go b/internal/provider/copilot_cli_test.go
index fc7a3968..09e40b76 100644
--- a/internal/provider/copilot_cli_test.go
+++ b/internal/provider/copilot_cli_test.go
@@ -78,6 +78,90 @@ func TestCopilotCLILogin(t *testing.T) {
 	}
 }
 
+// copilotSecretAsks is how many lines the keychain fake has been handed,
+// one per run of it.
+func copilotSecretAsks(t *testing.T, log string) int {
+	t.Helper()
+	b, err := os.ReadFile(log)
+	if err != nil {
+		return 0
+	}
+	return strings.Count(strings.TrimSpace(string(b)), "\n") + 1
+}
+
+// A keychain read the user watched fail — the access prompt denied — is
+// not asked again this run (#2408): asking again at the next account
+// listing is what brought the dialog back every ten minutes. An item that
+// isn't there (exit 44, nothing on screen) is still retried after the
+// short wait, so a sign-in made later in the CLI is found.
+func TestCopilotCLISecretDeniedNotAskedAgain(t *testing.T) {
+	oldSecret := copilotCLISecret
+	copilotCLISecret = copilotCLISecretReal
+	defer func() { copilotCLISecret = oldSecret }()
+
+	bin := filepath.Join(t.TempDir(), "bin")
+	os.MkdirAll(bin, 0o755)
+	asked := filepath.Join(t.TempDir(), "asked.log")
+	testenv.Program(t, filepath.Join(bin, "security"), `#!/bin/sh
+echo "$@" >> '`+asked+`'
+echo "security: SecKeychainItemCopyContent: User interaction is not allowed." >&2
+exit 51
+`)
+	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
+
+	const acc = "https://github.com:octocat"
+	if tok := copilotCLISecret(acc); tok != "" {
+		t.Fatalf("a denied read answered %q", tok)
+	}
+	if n := copilotSecretAsks(t, asked); n != 1 {
+		t.Fatalf("security ran %d times, want 1", n)
+	}
+
+	// the next account listing, after the ten-minute wait is over
+	copilotSecrets.Lock()
+	copilotSecrets.at[acc] = time.Now().Add(-11 * time.Minute)
+	copilotSecrets.Unlock()
+	if tok := copilotCLISecret(acc); tok != "" {
+		t.Fatalf("read again after a denial answered %q", tok)
+	}
+	if n := copilotSecretAsks(t, asked); n != 1 {
+		t.Fatalf("security ran %d times after a denial, want still 1", n)
+	}
+}
+
+// The item not being there shows the user nothing, so its read is still
+// retried once the short wait is over. Another login than the denial
+// test's, so the two stand on their own whichever order they run in.
+func TestCopilotCLISecretAbsentRetriedAfterTheWait(t *testing.T) {
+	oldSecret := copilotCLISecret
+	copilotCLISecret = copilotCLISecretReal
+	defer func() { copilotCLISecret = oldSecret }()
+
+	bin := filepath.Join(t.TempDir(), "bin")
+	os.MkdirAll(bin, 0o755)
+	asked := filepath.Join(t.TempDir(), "asked.log")
+	testenv.Program(t, filepath.Join(bin, "security"), `#!/bin/sh
+echo "$@" >> '`+asked+`'
+echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
+exit 44
+`)
+	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
+
+	const acc = "https://github.com:hubot"
+	if tok := copilotCLISecret(acc); tok != "" {
+		t.Fatalf("an absent item answered %q", tok)
+	}
+	copilotSecrets.Lock()
+	copilotSecrets.at[acc] = time.Now().Add(-11 * time.Minute)
+	copilotSecrets.Unlock()
+	if tok := copilotCLISecret(acc); tok != "" {
+		t.Fatalf("an absent item answered %q the second time", tok)
+	}
+	if n := copilotSecretAsks(t, asked); n != 2 {
+		t.Fatalf("security ran %d times, want 2 (retried once the wait was over)", n)
+	}
+}
+
 // On Linux the CLI 1.0's keyring store keys its token by service and
 // username, not keytar's account (#723); a keyring that never answers
 // doesn't hold the caller.
-- 
2.50.1 (Apple Git-155)

```

</details>

fork 分支：https://github.com/ggbdpq/magpie/tree/hunt25-agent-copilot-keychain-denial（base upstream/main 2e2c8903，commit 630cdb86）

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
