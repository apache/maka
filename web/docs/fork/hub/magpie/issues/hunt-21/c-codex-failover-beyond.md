# agent: 未接入的远程 Codex（WSL NAT / MAGPIE_ADDR 出回环）仍被账号 failover 写 openai_base_url 指到网关 Codex 路径，failover 的每个 turn 401（#2145 的 failover 兄弟面）

基线：upstream/main `ce5d9f9d4`（在 `2c18c697` 上发现，tip 前进后已重放红，补丁在新 tip `git apply --check` 通过）。
分支：https://github.com/ggbdpq/magpie/tree/hunt21-c-codex-failover-beyond

## 现象

#2145 修掉了「已接入（joined）」的远程 Codex 被并到 ChatGPT 登录旁的问题：`chatGPT()` 在 `onAnotherMachine(at.gw())` 时返回 false，接入时改为 magpie 作为 provider。但**未接入**的 Codex 还有一条路会被写到同一个地址：账号 failover（`Sync` 无条件调用）。WSL NAT（或 MAGPIE_ADDR 钉在回环之外）下，一台已登录 ChatGPT、没点接入的 Codex，只要 magpie 里还挂着同一供应商的第二个 ChatGPT 账号，Sync 就会把

```toml
openai_base_url = "http://<windows-gateway>:3425/backend-api/codex"
```

写进它的 config.toml 并在 stash 标 `codex.failover=1`。而 #2145 的报告者已实测：从另一台机器打到网关的 `/backend-api/codex/*` 一律 401（网关只收命名 key）。于是该 Codex 自己的账号额度用尽、需要 failover 的每个 turn 都 401——failover 在远程 Codex 上整体失效，且这是 magpie 未受邀写入的（failover 是 magpie 自己的主意）。

## 最小复现（修前红，当前 upstream/main）

测试 `TestCodexFailoverBeyondLoopbackNotWritten`（补丁内）：ChatGPT 登录的 Codex + logins.json 里第二个账号 on + `MAGPIE_ADDR=172.23.80.1:3425`，跑一次 `cx.Sync()`：

```
--- FAIL: TestCodexFailoverBeyondLoopbackNotWritten (0.83s)
    codex_failover_beyond_test.go:44: failover written beyond loopback:
        model = "gpt-5.5"
        openai_base_url = "http://172.23.80.1:3425/backend-api/codex"
FAIL
```

在 `2c18c697` 与 `ce5d9f9d4` 上都复现。这个写入形状与 #2145 报告者贴出的完全一致。

## 根因

`internal/agent/codex.go`，`codexIn` 里的 `failover()`（#2145 修复只改了 `chatGPT()`，约 :292）：

```go
on := !disconnected() && codexFailover()
if on && at.spell == nil && !codexProxyOK(path, at.gw()) {
    on = false
}
```

`on` 不看 `onAnotherMachine(at.gw())`。CC Switch mirror 分支（`model_providers.<mirror>.base_url = at.codexURL()`）与内置分支（`openai_base_url = at.codexURL()`）都由这个 `on` 放行。#2145 修复自己立的不变量——「never joined or beside，因为 beside 登录会把 ChatGPT token 发到 /backend-api/codex」——failover 写的正是同一种 beside 形状。

## 修法

一行门，与 `chatGPT()` 的门一致：

```go
on := !disconnected() && codexFailover() && !onAnotherMachine(at.gw())
```

自愈：已写入的 failover base URL 在下次 Sync 走 `case !on && viaBase() && owned: return dropBase()` 摘掉；mirror 同理。

## 验证

| 检查 | 结果 |
| --- | --- |
| 红（upstream/main `2c18c697`，新测试） | FAIL "failover written beyond loopback: openai_base_url = …backend-api/codex" |
| 红（tip 前进后重放 `ce5d9f9d4`） | 同样 FAIL |
| 绿（补丁在） | 同测试 ok；全量 `go test -tags nogui -count=1 ./internal/agent`（沙盒 HOME）152s ok，含 TestCodexOwnModelThroughMagpieWhileAccountsOn、TestCodexFailoverOnlyKeepsOwnModels、TestCodexHandWrittenBaseURLStays、TestCodexBeyondLoopbackNotJoined、TestCodexProxy* 等 |
| 补丁可 apply | `git apply --check` 在干净 `ce5d9f9d4` 上通过 |
| gofmt -l internal/agent | 空 |
| go vet darwin / GOOS=linux -tags nogui / GOOS=windows | 全过 |
| go build 三平台（darwin / linux nogui / windows） | 全过（darwin 仅既知 trayimage cgo 与 ld 告警） |

**没跑什么**：真机 WSL NAT + 已登录 ChatGPT 且未接入的 Codex（测试里 reachProbe/proxyProbe/codexProxyEnv 按包内 TestMain 惯例桩定）；Windows 盒子。failover 请求在回环内路径的行为不变，由既有 failover 测试守护。

补丁（`git format-patch -1 --stdout`，作者 ggbdpq，请保留）：

<details>
<summary>patch</summary>

```patch
From fac6513bfcc90f326ab8a4dbf2b60147dbe63b40 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 14 Oct 2026 22:08:02 +0800
Subject: [PATCH] agent: a Codex beyond loopback is never pointed at the Codex
 path for account failover, either

What changed:
- failover() no longer writes the base URL (or a CC Switch mirror's) for a
  Codex that reaches the gateway from another machine: #2145 took the
  joined case out (chatGPT() is false there), but Sync's failover write for
  a Codex signed in to ChatGPT and not connected kept pointing its
  failed-over turns at /backend-api/codex, where the gateway takes a named
  key alone, so every one came back a 401. One written before is taken off
  again by the same Sync (the !on branch drops failover's own base URL).
- docs/subsystems/agent-wiring.md: the failover paragraph says so.
- TestCodexFailoverBeyondLoopbackNotWritten: Sync under MAGPIE_ADDR beyond
  loopback with a second ChatGPT account on writes no openai_base_url and
  marks no codex.failover.

Run:
- red on upstream/main 2c18c697: FAIL "failover written beyond loopback:
  openai_base_url = \"http://172.23.80.1:3425/backend-api/codex\"";
  green with the change.
- go test -tags nogui -count=1 ./internal/agent (152s, sandbox HOME): ok,
  the failover, beyond-loopback and switch-only tests among them.
- gofmt -l internal/agent: clean. go vet ./internal/agent on darwin,
  GOOS=linux -tags nogui, GOOS=windows: clean.
- go build -o /dev/null . on darwin, GOOS=linux -tags nogui,
  GOOS=windows: ok (darwin's known trayimage cgo and ld warnings only).

Not tried: a real WSL distro under NAT with a ChatGPT-signed-in,
not-connected Codex while a second ChatGPT account is on in magpie (the
proxy and reach probes are stubbed in tests); the Windows box.
---
 docs/subsystems/agent-wiring.md              |  2 +-
 internal/agent/codex.go                      |  5 +-
 internal/agent/codex_failover_beyond_test.go | 49 ++++++++++++++++++++
 3 files changed, 54 insertions(+), 2 deletions(-)
 create mode 100644 internal/agent/codex_failover_beyond_test.go

diff --git a/docs/subsystems/agent-wiring.md b/docs/subsystems/agent-wiring.md
index d4a0b204..1ee92d07 100644
--- a/docs/subsystems/agent-wiring.md
+++ b/docs/subsystems/agent-wiring.md
@@ -85,7 +85,7 @@ something else shows up as drift.
 - `proxied` (Muma102kMichael on X: every project and every new chat 502 after magpie took Codex over) is this machine's Codex sending its requests for the gateway through a proxy that doesn't pass them on, while the gateway answers here ([`codex_proxy.go`](../../internal/agent/codex_proxy.go)). Codex's reqwest takes `HTTP_PROXY`, else the system's proxy for `http://` (macOS' HTTP entry alone, never its HTTPS or SOCKS one; Windows' `ProxyServer` only when it is one address for every protocol), else `ALL_PROXY`, and lets only an exact IP or a CIDR in `NO_PROXY` (on Windows, with no `NO_PROXY`, the bypass list with `*.` taken out) keep 127.0.0.1 off it: `127.*` and `localhost` don't, and macOS' exceptions aren't read. With `[features] respect_system_proxy` it asks the system alone, matching its list itself, wildcards and `<local>` included, and goes direct when no proxy is set there; a macOS SOCKS entry alone it can't use, and takes `HTTP_PROXY`/`ALL_PROXY` then (codex-rs `outbound_proxy`; tried with codex-cli 0.162.1). Its reqwest has no SOCKS, so a `socks5://` proxy is spoken to as an HTTP one, and the probe does the same. The environment is Codex's: the login shell's `*_PROXY` (`proc.LoginEnv`, which a terminal's Codex and the ChatGPT app's both have) over magpie's own, which a magpie opened from the Dock lacks (liu_dyj on X: a `NO_PROXY=127.0.0.1` in the profile, or a macOS proxy with no HTTP entry, warned while Codex went direct). `codexProxyFor` works out that proxy the same way, and a `GET /` through it must come back as magpie's (`proxyProbe`), tried as `reachable` is. Its pill says how to fix it, as `unreachable`'s does, naming the proxy (`Addr`, `Detail`) through `netproxy.Redact`, without its user and password (#1886), while the probe goes through it whole, and the dialog has Disconnect from magpie. Account failover, which magpie writes uninvited, waits for that probe (`codexProxyOK`) and isn't written while the proxy doesn't pass Codex on, and one it wrote goes again. Tests stub the env, the system proxy and `proxyProbe` in `TestMain`.
 - Listing never starts a stopped WSL distro. A stopped distro's agent shows what was last seen there (`asleep`, `wsl.json`); setting one of its fields writes its files, which starts the distro.
 - Codex's sign-in (`login`) is ChatGPT (`""`, the default), Always ChatGPT (`chatgpt`) or magpie API (`api`). With ChatGPT, magpie's models join Codex's own beside the sign-in (`openai_base_url`), and while the Codex app holds the ChatGPT account Codex is signed in to (`codexUsedUp`, `provider.CodexUsedUp`: OpenAI no longer allows the account and it has no credits left, a workspace still within its overage excepted), magpie is made Codex's provider (`codex.out`): the Codex app sends nothing at all on an account it holds, a magpie model's turn included (#540), and as a provider of its own magpie is past that. A window at 100% with credits left doesn't count, and Codex stays signed in. Sync puts it back beside the sign-in once the account has room. Always ChatGPT never does that: Codex stays in its ChatGPT state, and the Codex app may send nothing till the account has room, while Codex CLI's turns still reach magpie by the base URL, and its routing and other accounts serve them. With magpie API, Codex's `getAuthStatus` returns no token (its provider has no `requires_openai_auth`), so its Chrome control turns away; the option's note says to pick ChatGPT to keep it (#1824). A Codex that reaches the gateway from another machine (a WSL distro under NAT, or `MAGPIE_ADDR` pinned beyond loopback, `onAnotherMachine(at.gw())`) is wired as one with no ChatGPT sign-in (`chatGPT()` is false there): never joined or beside, since beside its sign-in it would send its ChatGPT token to `/backend-api/codex`, and from there the gateway takes a named key alone, so every request was a 401 (#2145, `TestCodexBeyondLoopbackNotJoined`). magpie is its provider and it sends `gwKey()`, the LAN sharing key; one of its own models picked goes straight to OpenAI on its sign-in.
-- Codex signed in to ChatGPT and not connected still gets `openai_base_url` while more of its ChatGPT accounts are on in magpie (`failover`, stash `codex.failover`; with a CC Switch mirror as its provider, the mirror's `base_url` and `codex.mirror_failover`), so a turn its own account has no allowance for goes on to the next. That Codex is `FailingOver`: not `Wired`, yet its requests go through magpie. The Agents row says so and what turns it off (`FailoverSaid` in the CLI and TUI, `failover` in `/api/state`, a button to Providers › Codex in the GUI), and the gateway hands it only its own models from `/backend-api/codex/models` (`CodexOwnOnly`, set on `gateway.CodexOwnOnly` by main; its ETag carries `provider.CodexOwnListTag`, and Sync ages a `models_cache.json` without it). A connected WSL Codex shares the gateway path, so while one is connected every Codex gets magpie's models (#1385). A base URL the user wrote by hand (#856) isn't failover's and stays a plain not-connected row. A Codex the user disconnected gets no failover till they connect it again. The app serving the gateway takes failover out as it quits (`EndFailover`, `EndCodexFailover` in `OnShutdown`), so a Codex left on its own goes straight to OpenAI rather than retrying a gateway that's gone (Leon920717 on X); the next start's Sync writes it again. Codex's app-server read the old base URL as it started and keeps it, and `KeepCodexDaemonCurrent` ends with magpie, so `EndCodexFailover` restarts it there when no codex session is on it (`codexDaemonCheck`); with one on it, it stays on the gone gateway until the user restarts it (thisisvainxx on X: "several restarts"). A connected Codex keeps magpie as it quits: its model is one of magpie's, and Disconnect is what puts its own config back. A magpie that ends without quitting (killed, a crash, `magpie serve`) leaves failover in place.
+- Codex signed in to ChatGPT and not connected still gets `openai_base_url` while more of its ChatGPT accounts are on in magpie (`failover`, stash `codex.failover`; with a CC Switch mirror as its provider, the mirror's `base_url` and `codex.mirror_failover`), so a turn its own account has no allowance for goes on to the next — never for a Codex that reaches the gateway from another machine, where that path takes a named key alone and the failed-over turn came back a 401 (#2145, `TestCodexFailoverBeyondLoopbackNotWritten`); Sync takes one it wrote before off again. That Codex is `FailingOver`: not `Wired`, yet its requests go through magpie. The Agents row says so and what turns it off (`FailoverSaid` in the CLI and TUI, `failover` in `/api/state`, a button to Providers › Codex in the GUI), and the gateway hands it only its own models from `/backend-api/codex/models` (`CodexOwnOnly`, set on `gateway.CodexOwnOnly` by main; its ETag carries `provider.CodexOwnListTag`, and Sync ages a `models_cache.json` without it). A connected WSL Codex shares the gateway path, so while one is connected every Codex gets magpie's models (#1385). A base URL the user wrote by hand (#856) isn't failover's and stays a plain not-connected row. A Codex the user disconnected gets no failover till they connect it again. The app serving the gateway takes failover out as it quits (`EndFailover`, `EndCodexFailover` in `OnShutdown`), so a Codex left on its own goes straight to OpenAI rather than retrying a gateway that's gone (Leon920717 on X); the next start's Sync writes it again. Codex's app-server read the old base URL as it started and keeps it, and `KeepCodexDaemonCurrent` ends with magpie, so `EndCodexFailover` restarts it there when no codex session is on it (`codexDaemonCheck`); with one on it, it stays on the gone gateway until the user restarts it (thisisvainxx on X: "several restarts"). A connected Codex keeps magpie as it quits: its model is one of magpie's, and Disconnect is what puts its own config back. A magpie that ends without quitting (killed, a crash, `magpie serve`) leaves failover in place.
 - A Codex thread keeps the provider it was started on. While a magpie model is on, CC Switch's provider tables go through magpie too (`takeTables`), and get their own base URL back when Codex steps off magpie (`giveTables`, stash `codex.tables`). CC Switch's OpenAI mirror (a table of another id, `name = "OpenAI"`, `requires_openai_auth`, no `base_url`) isn't reached by `openai_base_url`, which takes only the built-in provider to magpie: a thread started on it and reopened went straight to ChatGPT, which refused the magpie model picked in it, and magpie never saw the request (#1796). While Codex goes to magpie by the base URL, `takeMirrors` gives each such mirror magpie's ChatGPT backend as its `base_url` (stash `codex.mirrors`), and `giveMirrors` takes it off again; a mirror a profile names, or one whose `base_url` was changed since, stays as it is. Moving the threads onto another provider is the Sessions page's Move (#887).
 - An agent's config is written in the form the installed version reads, taken from what that version declares, not the latest one. VSCodium has no Copilot Chat of its own, and the Marketplace's last one (0.48.1) has no Custom Endpoint provider, only OpenAI Compatible (`customoai`, #1014). magpie reads the provider list in the package.json of the `github.copilot-chat` installed under `~/.vscode-oss/extensions` (`vscodeChatOf`). It writes its group for `customendpoint` when that is declared, for `customoai` when only that is, with each model's window as `maxInputTokens` + `maxOutputTokens` and the token as `x-api-key` (that version drops an Authorization in `requestHeaders`). A missing or unreadable extension keeps `customendpoint`. Sync rewrites a group written for the other provider, and Check reports it, as it does a Copilot Chat declaring neither. That Copilot Chat registers its providers only while signed in to GitHub with a personal Copilot plan, which the Notice says.
 - Tuned settings are written only on the user's click, never by Sync or Connect. The value there before is stashed once (`tune.<agent>.<knob>[.<model>]` in `stash.json`), so Undo puts it back, or takes the key out (and a `modelSettings` entry left empty). A value the user changed after the click is theirs: Undo then only forgets the stash. A variable that comes before the setting (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, in settings.json's `env` or magpie's own) is shown as `locked` and Apply refuses, since the setting would change nothing. Claude Code compacts at the smaller of the window set and the model's own (its `/autocompact` says "capped to 200k by model"), so advice starts from that, and a model that isn't Claude's has no window here (magpie's own compact wiring serves it). Advice changes a value only when the replay saves 3% or more, and of the windows within 1% of the cheapest takes the largest; with the compactions timed, it never advises a window that compacts more often than the one now, so never a longer wait: of the windows that compact no more often it takes the cheapest, and of those within 3% of that (`sameCost`, the same bar as changing at all) the one that compacts least, the larger of two that compact as often. Tokens and seconds share no unit the files measure, so the advice doesn't trade one for the other at a guessed rate; a cheaper window that waits longer is said with its wait in the row and the picker, for the user to choose. The wait per compaction is taken as the same at every window: the files time compactions only near the window the user ran with, too narrow to fit how it grows with the prompt. Tokens are weighed as billed: cache reads 0.1, 5-minute writes 1.25, hour writes 2, output 5 for Claude; reads 0.1, writes 1, output 8 otherwise.
diff --git a/internal/agent/codex.go b/internal/agent/codex.go
index 860370a5..8cdf22ba 100644
--- a/internal/agent/codex.go
+++ b/internal/agent/codex.go
@@ -733,7 +733,10 @@ func codexIn(at place) *Agent {
 		if p != "" && p != "openai" && !mirror {
 			return nil
 		}
-		on := !disconnected() && codexFailover()
+		// a Codex that reaches the gateway from another machine is never
+		// pointed at the Codex path: the gateway takes a named key there,
+		// so the turn failover handed it came back a 401 (#2145)
+		on := !disconnected() && codexFailover() && !onAnotherMachine(at.gw())
 		// failover is magpie's own idea, not the user's: never handed
 		// Codex's requests while a proxy they'd go through doesn't pass
 		// them on to magpie, which would have every turn fail with 502
diff --git a/internal/agent/codex_failover_beyond_test.go b/internal/agent/codex_failover_beyond_test.go
new file mode 100644
index 00000000..48f3554b
--- /dev/null
+++ b/internal/agent/codex_failover_beyond_test.go
@@ -0,0 +1,49 @@
+package agent
+
+import (
+	"encoding/base64"
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"strings"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// A Codex signed in to ChatGPT that reaches the gateway from another
+// machine (MAGPIE_ADDR pinned beyond loopback; a WSL distro under NAT is
+// the same to it) is never pointed at the gateway's Codex path for account
+// failover either: from there the gateway takes a named key alone, so the
+// turn failover handed magpie came back a 401 — the shape #2145 took out
+// of the joined case, still written by failover for a Codex not connected.
+func TestCodexFailoverBeyondLoopbackNotWritten(t *testing.T) {
+	claims := func(m map[string]any) string {
+		b, _ := json.Marshal(m)
+		return "h." + base64.RawURLEncoding.EncodeToString(b) + ".s"
+	}
+	auth := func(email, acct string) map[string]any {
+		return map[string]any{"auth_mode": "chatgpt", "tokens": map[string]any{
+			"id_token":      claims(map[string]any{"email": email}),
+			"access_token":  claims(map[string]any{"exp": time.Now().Add(time.Hour).Unix()}),
+			"refresh_token": "r-" + acct, "account_id": acct}}
+	}
+	me, _ := json.Marshal(auth("me@example.com", "acct-1"))
+	home, read := codexHome(t, string(me), "model = \"gpt-5.5\"\n")
+	b, _ := json.Marshal([]map[string]any{{"agent": "codex", "user": "spare@example.com", "on": true,
+		"seen": time.Now(), "auth": auth("spare@example.com", "acct-2")}})
+	os.MkdirAll(filepath.Dir(provider.Path()), 0o755)
+	os.WriteFile(filepath.Join(filepath.Dir(provider.Path()), "logins.json"), b, 0o600)
+	t.Setenv("MAGPIE_ADDR", "172.23.80.1:3425")
+	cx := codex(home)
+	if err := cx.Sync(); err != nil {
+		t.Fatal(err)
+	}
+	if cfg := read(); strings.Contains(cfg, "openai_base_url") || strings.Contains(cfg, "backend-api/codex") {
+		t.Fatalf("failover written beyond loopback:\n%s", cfg)
+	}
+	if s := stashLoad(); s["codex.failover"] == "1" {
+		t.Fatalf("failover marked beyond loopback: %v", s)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

Generated-by: GLM-5.3-Flash (ZCode)
