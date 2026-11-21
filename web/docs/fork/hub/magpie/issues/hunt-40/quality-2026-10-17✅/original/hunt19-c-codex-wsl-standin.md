# agent: WSL 里的 Codex 报一个 magpie 不认识的模型名时，不落到它 config 里的模型（StandIn 的 WSL 兄弟面）

## 现象

一台 Windows 主机上，Codex 装在 WSL 发行版里、由 magpie 接线（`model_provider = "magpie"`，#2145 之后 NAT 下的 WSL Codex 一律是这个形态），Windows 侧没有装 Codex 或没接线。这个 WSL Codex 报一个 magpie 不提供的模型名时——用户 `codex -m <模型>`，或 Codex 用 OpenAI 的名字报某个内部模型——网关的 stand-in 查询 `StandIn("codex", …)` 只读 Windows 本机的 `~/.codex/config.toml`，读不到发行版里那份真正接线了的配置，返回空，请求按未知模型 404。同一个发行版里的 Claude Code 没有这个问题：#254（872bba3c）给 `StandIn` 加了 `wslClaudeStandIn`，本机没有 stand-in 时会去正在运行的发行版里找；Codex 是 WSL 支持里最早的成员（wslKinds 第一项），却始终没有对应物。

说明影响面：Codex 最常见的两类不认识的名字（memory 调用和 `codex-auto-review` 自动审批）已由 `codexMemoryStandIn` 用台账里它上一轮的模型兜住（WSL Codex 的轮次同样过网关，所以能兜到）；剩下的是用户显式 `codex -m <unserved>` 这类请求——本机 Codex 会落到 config 的 `model`，WSL Codex 直接 404。另外若 Windows 侧也装了 Codex 且接线到另一个模型，WSL Codex 会被 stand-in 到 Windows 侧那份配置的模型，而非自己配置里的。

## 最小复现

红测试 `TestWSLCodexStandIn`（`internal/agent/wsl_codex_stand_test.go`，仿 `wsl_claude_test.go` 的 `TestWSLClaudeStandIn`：fake distros 沙盒 HOME，不碰真机）。基线 331c2770 上，测试引用的 `wslCodexStandIn` 尚不存在，按 #2017 复验过的桥接法（旧树加只含该符号、零行为的 `_test.go`）复现断言级红：

```
--- FAIL: TestWSLCodexStandIn (0.74s)
    wsl_codex_stand_test.go:41: stand-in: ""
FAIL
FAIL	github.com/yetone/magpie/internal/agent	1.249s
```

发行版 `~/.codex/config.toml` 明明是 `model_provider = "magpie"` + `model = "relay/main"`，stand-in 却是空。第二个测试 `TestWSLCodexStandInSkipsStopped` 守护 da5f7a811 的保证：停掉的发行版绝不被打开（去掉 `wsl.running` 过滤后它红：`stand-in from a stopped distro: "stopped/model"`）。

## 根因

`internal/agent/claude.go` 的 `StandIn`（现 2267 行附近）：

```go
if agent == "codex" {
	return codexStandIn(filepath.Join(here(home).codexHome(), "config.toml"))
}
```

codex 分支只读本机配置，没有 claude 分支（下一行）那样的 Windows 兜底：

```go
if m := claudeStandIn(filepath.Join(here(home).claudeDir(), "settings.json"), model); m != "" || runtime.GOOS != "windows" {
	return m
}
// a Claude Code in WSL is known by the same User-Agent
return wslClaudeStandIn(model)
```

#254 给 claude 补 WSL stand-in 时 codex 未被回看；`wslCodexStandIn` 从此缺席。e31384b1f（codex stand-in 的起点）早于 #254，当时两者都没有 WSL 分支。

## 修法

镜像被接受的 claude 设计，三点：

1. `internal/agent/wsl.go`：把 `wslClaudeStandIn` 开头的「正在运行、探到过 kind、mirror 已定」的发行版收集提成 `wslReady(kind)`（两兄弟共用，下一个 WSL agent 直接复用）；新增 `wslCodexStandIn()`——第一个正在运行、`config.toml` 里 `model_provider = "magpie"` 的发行版，返回其 `model`（判定谓词与本机 `codexStandIn` 完全一致）。只问 magpie 的记忆与运行列表（`wslRunningLocked`），不探针、不开停掉的发行版。
2. `internal/agent/claude.go` 的 `StandIn` codex 分支照 claude 分支的形状接线：本机有答案、或不在 Windows，就返回本机答案；否则问 `wslCodexStandIn()`。非 Windows 平台行为逐字节不变。
3. `docs/subsystems/gateway-routing.md` Model resolution 行的 stand-in 句补「in a WSL distro, the distro's own, of the ones running now」。

发行版若指向别家的 magpie（`model_provider` 同为 `magpie`），stand-in 返回的 id 在本网关 Resolve 失败，请求仍 404——与修前一致，无回归。

## 验证

| 项 | 结果 |
| --- | --- |
| 红（基线 331c2770 + 零行为桥接，沙盒 HOME） | `TestWSLCodexStandIn` FAIL：`stand-in: ""` |
| 绿（本补丁） | `TestWSLCodexStandIn`、`TestWSLCodexStandInSkipsStopped`、`TestWSLClaudeStandIn`、`TestCodexStandIn`、`TestClaudeStandIn` 全过 |
| 有牙 1：`wslCodexStandIn` 函数体改为 `return ""` | `TestWSLCodexStandIn` 回红（`stand-in: ""`），恢复后绿 |
| 有牙 2：`wslReady` 去掉 `wsl.running[n]` 过滤 | `TestWSLCodexStandInSkipsStopped` 回红（`stand-in from a stopped distro: "stopped/model"`），恢复后绿 |
| gofmt -l internal/agent docs | 干净 |
| go vet -tags nogui ./internal/agent | 干净 |
| go build（darwin）/ GOOS=linux -tags nogui / GOOS=windows | 三平台全过（darwin 的 cgo `-Wenum-conversion` 与 ld 版本告警为已知环境噪音） |
| go test -tags nogui ./internal/agent（全包） | 见下 |

**没跑什么**：真实 Windows/WSL（本机是 Mac；#254 自己的验证也止于 fake distros，`Not tried on real Windows/WSL`）；`StandIn` 里 Windows-only 的分支接线在 darwin 上不可执行，其形状与已接受的 claude 分支逐行同构，函数级行为由 `TestWSLCodexStandIn` 覆盖；gateway 包测试未跑（其 `StandIn` 全部为测试内 stub，不接 `agent.StandIn`，改动不触及）；全量 `go test ./...` 未跑（三猎手并行，按约定只跑目标包与三平台 vet/build）。

补丁基线：upstream/main `331c2770`（交付前 fetch 过，其上仅新增 provider/tui/tests 四提交，不涉本车道）。附 `git format-patch -1 --stdout` 全文：

```patch
From 49b761fdbe4a69ab3f0b272f2ca5379ed7cb0407 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 14 Oct 2026 20:14:38 +0800
Subject: [PATCH] agent: a Codex in a WSL distro stands in for a model it names
 from its own config.toml
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: StandIn("codex", …) read this machine's ~/.codex/config.toml
alone, so a Codex wired in a WSL distro (model_provider = "magpie", the
only shape a distro under NAT is wired in since #2145) naming a model
magpie doesn't serve — codex -m <unserved> — was answered 404, where this
machine's Codex goes to its config's model and a Claude Code in the same
distro goes to the stand-in its settings name (wslClaudeStandIn, #254).
The collecting of the distros running now that the probe found a kind in
(wslReady) is shared by the two stand-ins, and wslCodexStandIn takes the
first whose config.toml has magpie as its provider, as codexStandIn reads
it. Only magpie's memory and the running list are asked; a stopped distro
is never opened (TestWSLCodexStandInSkipsStopped). Off Windows nothing
changes: the local answer is returned as before. The model resolution row
in gateway-routing.md says the distro's config is asked.

Run:
- go test -tags nogui -count=1 -run
  'TestWSLCodexStandIn|TestWSLClaudeStandIn|TestCodexStandIn|TestClaudeStandIn'
  ./internal/agent: ok.
- On 331c2770 with the new test plus a zero-behavior wslCodexStandIn
  bridge (the old shape), TestWSLCodexStandIn fails: stand-in: "".
- With the body of wslCodexStandIn hand-replaced by return "", it fails
  the same way; with wslReady's running filter taken out,
  TestWSLCodexStandInSkipsStopped fails with "stopped/model"; restored.
- go test -tags nogui -count=1 ./internal/agent: ok (152s).
- gofmt -l (clean); go vet -tags nogui ./internal/agent (clean);
  go build (darwin), GOOS=linux go build -tags nogui, GOOS=windows
  go build -o /dev/null . (all ok).

Not tried: a real WSL distro on the Windows box (this machine is a Mac;
#254's own stand-in test is fake distros too); the Windows-only branch of
StandIn itself, whose shape is the claude branch beside it.

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/gateway-routing.md     |  2 +-
 internal/agent/claude.go               |  9 ++-
 internal/agent/wsl.go                  | 39 +++++++++---
 internal/agent/wsl_codex_stand_test.go | 87 ++++++++++++++++++++++++++
 4 files changed, 125 insertions(+), 12 deletions(-)
 create mode 100644 internal/agent/wsl_codex_stand_test.go

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index ba6537ab..cda7c486 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -18,7 +18,7 @@ served by a plugin are in [Provider and plugin ownership](provider-plugins.md).
 | Address and caller | `DefaultAddr`. The local token `magpie` and the per-agent `magpie-<agent>` (`TokenFor`). `agentOf` tells which agent asked, first by token, then by User-Agent. | [`gateway.go`](../../internal/gateway/gateway.go) |
 | TLS | `--tls-cert`/`--tls-key` (`MAGPIE_TLS_CERT`, `MAGPIE_TLS_KEY`) make `ListenAndServe`, `Relisten` (both through `Server.listen`) and `magpie web`'s page (`ServeTLS`) wrap the listener in `tlsListener`. A connection from another computer is `tls.Server` at once, so its plain HTTP gets net/http's 400. One from this computer (`fromThisComputer`: loopback, or a peer address equal to the local one) is sniffed on its own goroutine, 10s at most (`sniffWait`), and 0x16 makes it TLS, so `URL()`, the agents, MCP servers, `ServedBy` and the healthcheck keep `http://127.0.0.1`. `certFiles.get` reloads the pair when either file's mtime or size changes; a pair that doesn't load keeps the one served (logged once per change). `tlsConfig` refuses half a pair or files that don't load before binding. HTTP/1.1 only over TLS (hijack, Codex's websocket). `Scheme()` gives the scheme of `LANURLs`, a scheme-less `MAGPIE_PUBLIC_URL` and the page's network links. Host and Origin checks (`foreignPage`, `rebound`) don't depend on the scheme. | [`tls.go`](../../internal/gateway/tls.go), [`lan.go`](../../internal/gateway/lan.go) |
 | HTTP surface | `Handler` routes `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (each also without `/v1`), `/v1/models`, Gemini's `/v1beta/models/…`, the Codex backend path, `/v1/codex/models` (Codex's catalog shape for a Codex elsewhere with a gateway key, `codexCatalog`, kept to the key's models by `keyAllowed`; #1281), `/mcp/{name}`, `/mcp/magpie/web-search` and `/mcp/magpie/vision` (magpie's own web search and image recognition as MCP servers, below) and the `/v1/magpie/*` status endpoints. `/v1/alpha/search` (also without `/v1`, and on the Codex backend path for a magpie model) is Codex's web.run search (`alphaSearch`, `codex_search.go`): a ChatGPT account's model goes to the ChatGPT backend's `/alpha/search` on the account's sign-in, the next account asked on 401, 403, 429 or 5xx; any other model's `search_query` is searched by `webSearch`, and when nothing answers the reason is a 200 with `output`, since Codex ends the turn on any failed web.run (anton on Discord). A GET on `/v1/responses` (a client opening Responses over a WebSocket) is answered 426, a plain one 405: Responses is relayed over HTTP only. Every route is wrapped in `counted`, `corsGuard`, `callerGuard`, `withCaller` and `keyLimited`; `/v1/messages`, `/messages` and `/v1/messages/count_tokens` in `keepsSignIn` too. `corsGuard` (#1051) serves CORS only to the origins listed in Settings › Network › Web pages (`settings.CORSOrigins`, cleaned to `scheme://host[:port]` by `settings.CleanOrigins`, which refuses a wildcard). A browser extension's own pages, popup and service worker are listed the same way by their origin, which is the browser's scheme and the extension's id: `chrome-extension://<id>` (Chromium, the id 32 letters a–p), `moz-extension://<uuid>` (Firefox, the Internal UUID about:debugging shows, not the add-on id) and `safari-web-extension://<uuid>` (Safari, which picks a new UUID on each launch, so a listing lasts until Safari restarts); the id must have that browser's shape, cased any way, and nothing else is taken — no bare scheme, no wildcard, no path (SkyAerope on Discord: an extension without host permissions is held to CORS like a page). A content script's fetch carries the page's origin, not the extension's. A listed extension is treated exactly as a listed page, below; one not listed passes as before (other schemes, below) with no CORS headers. For a listed origin it answers the preflight (204) and adds `Access-Control-Allow-Origin`, and every other request from it needs an enabled gateway key (`access.Authenticate`), even on loopback, or gets a 401. It takes the key from the caller `lanGuard` recorded too, since on the running server `lanGuard` has already put magpie's own token in the key's place. Any other web page is refused 403 on every route (`foreignPage`): on loopback a call needs no key and the body's Content-Type isn't checked, so a page the user visits could otherwise send a "simple" `text/plain` POST and spend their subscriptions blind. Only an `http`/`https` Origin is judged, and one on this computer (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, any port) or the request's own origin (its host and port equal to `Host`, such as a page on the gateway's LAN address) passes, as does usemagpie.ai on `/v1/magpie/omarchy`. `null` and other schemes (`app://`, `file://`, `tauri://`, `vscode-webview://`, `chrome-extension://`) come from desktop apps, webviews and extensions that don't enforce CORS, and pass. A request with no Origin (every agent's) passes through with no CORS headers, as before. A page whose own name resolves to 127.0.0.1 (DNS rebinding) would count as same-origin here, so `lanGuard` refuses it first (`rebound`, 403): a loopback request carrying a browser's marks (`Origin`, `Sec-Fetch-Site`/`Sec-Fetch-Mode`, a `Mozilla/` user agent) whose `Host` isn't this computer's (an IP, `localhost`, `*.localhost`, a container runtime's name for the host such as `host.docker.internal`, `MAGPIE_PUBLIC_URL`'s or `MAGPIE_ADDR`'s host, the machine's own name) needs an enabled gateway key. Agents send none of those marks and pass under any name. Before any of that, `lanGuard` lets in one request without a key from anywhere: `POST /_magpie/claude-mcp/<token>` with the token of a Claude subscription run now live (`ownCallback`, see [the Claude subscription bridge](claude-subscription-bridge.md)), the run's MCP helper calling back to a `MAGPIE_ADDR` that isn't loopback (#1546). Next, before the key or `rebound` is looked at, the allow list (lc on Discord, magpie in Docker on a public host): with `MAGPIE_ALLOW_IPS` or Settings › Network › Allowed addresses (`settings.AllowIPs`; the variable wins and the page then only shows it) naming IPs and CIDR ranges, a request whose connection (`RemoteAddr`, IPv4-mapped IPv6 unmapped, zone dropped) is outside them is refused 403 naming its address, even with an enabled gateway key (`refuseNotAllowed`). Loopback and this computer's own interface addresses always pass. A forwarding header is never taken for the address, so a proxy or tunnel on this computer passes (it arrives from loopback) and its clients are limited at the proxy. An entry that doesn't parse lets nothing in and is logged once; the list stays on. Settings' list is read with `settings.LoadChecked`: a settings.json that can't be read, or doesn't parse with no last good generation, is unknown, never "no list", so the list read last in this process stays in force (`lastAllow`), and with none read yet only this computer passes, the 403 saying settings.json couldn't be read; logged once. No file, or an empty one, is no list. The Settings page's saves read with `LoadChecked` too and refuse such a file, as `settings.Save` does. `magpie web`'s server is wrapped in the same check (`AllowGuard`). Settings refuses a list that would leave out the address the page saving it is open from (`KeepsOut`); the page names that address, which behind Docker or a proxy is the proxy's, and offers to add it to the refused list (`allowSays`, Mathresearcher on Discord). | [`gateway.go`](../../internal/gateway/gateway.go), [`allow.go`](../../internal/gateway/allow.go), [`internal/settings/allowips.go`](../../internal/settings/allowips.go), [`cors.go`](../../internal/gateway/cors.go), [`codex_catalog.go`](../../internal/gateway/codex_catalog.go), [`internal/settings/origins.go`](../../internal/settings/origins.go) |
-| Model resolution | `serve` resolves the model the agent asked for: Claude tier stand-ins, a routing group (`provider.GroupFor`: its id, the model's id however a vendor spells it, else the one group whose name it is, unless a provider serves a model by that id), auto stand-ins, the agent's own stand-in (`StandIn`: Codex's config.toml `model` when magpie is its provider, for a name it sends that magpie doesn't serve, such as its auto-review's `codex-auto-review`), itself taken through `GroupFor` and auto stand-ins so a config naming a group bare reaches it, then `provider.Resolve`. A Codex memory call or auto-review (`x-openai-subagent: guardian`, or `codex-auto-review`) that still names no served model goes to the model Codex's last turn was answered on (`codexMemoryStandIn`, per agent and gateway key), so a Codex on magpie through another provider table, a profile or another computer isn't answered 404 (Adam on Discord, `TestCodexAutoReviewReachesItsTurnsModel`). A bare model id several providers serve (MOMO on Discord: `glm-5.3` under opencode-go and a6api) is never refused: with found groups on (the default) `GroupFor` takes it to the group magpie found for it (`auto-<slug>`), its members in the Providers order, routed and failed over as any group, a conversation staying with the member that answered it while its cache is worth it (affinity); with them off, `Resolve` takes the first provider in the Providers order that exposes it, with no fallback. magpie writes only `provider/model` ids into agents' configs (`magpieModels`), so a bare id is one the user wrote. `/v1/models` lists bare ids only when the user asks for them ([Model ids without the provider](#model-ids-without-the-provider)). Every reply says who answered in `X-Magpie-Provider` and `X-Magpie-Model` (`noteMember`), and the usage log and the Routing page keep it. A model id with `~` and no slash that resolves as nothing else is the one served id (a provider's model or a group) whose slashes it spells as `~` (`unflat`, `provider.Unflat`; MiniMax Code's spelling, #1387), taken back in `validateModel` before key limits, middleware and usage see it; two ids spelled alike are neither. A Claude model id whose version is dashed (`relay/claude-opus-4-6-us`, with or without `:level` and `[1m]`) that is not served as spelled is the one served id it dashes (`provider.ClaudeUndashed`; the spelling magpie gives Claude Code, which reads a dotted version as Claude Opus 4), taken back in `validateModel` and `unprefixed` the same way. An unknown model gets a 404 naming why: a switched-off provider, a disabled group or an empty group. Otherwise it names up to three ids nearest to what was asked (`provider.Closest`: words of a model's display name count before words of its id, and a provider's id or name only alongside them, so "Zen-Space-Bunny" is told `opencode-zen-free/space-bunny-free`, MOMO on Discord), then the ways a model can be named, then every id (`unknownModel`; chat and embeddings). | [`gateway.go`](../../internal/gateway/gateway.go), [`internal/provider/group.go`](../../internal/provider/group.go), [`internal/provider/flat.go`](../../internal/provider/flat.go), [`internal/provider/claudedash.go`](../../internal/provider/claudedash.go) |
+| Model resolution | `serve` resolves the model the agent asked for: Claude tier stand-ins, a routing group (`provider.GroupFor`: its id, the model's id however a vendor spells it, else the one group whose name it is, unless a provider serves a model by that id), auto stand-ins, the agent's own stand-in (`StandIn`: Codex's config.toml `model` when magpie is its provider — in a WSL distro, the distro's own, of the ones running now — for a name it sends that magpie doesn't serve, such as its auto-review's `codex-auto-review`), itself taken through `GroupFor` and auto stand-ins so a config naming a group bare reaches it, then `provider.Resolve`. A Codex memory call or auto-review (`x-openai-subagent: guardian`, or `codex-auto-review`) that still names no served model goes to the model Codex's last turn was answered on (`codexMemoryStandIn`, per agent and gateway key), so a Codex on magpie through another provider table, a profile or another computer isn't answered 404 (Adam on Discord, `TestCodexAutoReviewReachesItsTurnsModel`). A bare model id several providers serve (MOMO on Discord: `glm-5.3` under opencode-go and a6api) is never refused: with found groups on (the default) `GroupFor` takes it to the group magpie found for it (`auto-<slug>`), its members in the Providers order, routed and failed over as any group, a conversation staying with the member that answered it while its cache is worth it (affinity); with them off, `Resolve` takes the first provider in the Providers order that exposes it, with no fallback. magpie writes only `provider/model` ids into agents' configs (`magpieModels`), so a bare id is one the user wrote. `/v1/models` lists bare ids only when the user asks for them ([Model ids without the provider](#model-ids-without-the-provider)). Every reply says who answered in `X-Magpie-Provider` and `X-Magpie-Model` (`noteMember`), and the usage log and the Routing page keep it. A model id with `~` and no slash that resolves as nothing else is the one served id (a provider's model or a group) whose slashes it spells as `~` (`unflat`, `provider.Unflat`; MiniMax Code's spelling, #1387), taken back in `validateModel` before key limits, middleware and usage see it; two ids spelled alike are neither. A Claude model id whose version is dashed (`relay/claude-opus-4-6-us`, with or without `:level` and `[1m]`) that is not served as spelled is the one served id it dashes (`provider.ClaudeUndashed`; the spelling magpie gives Claude Code, which reads a dotted version as Claude Opus 4), taken back in `validateModel` and `unprefixed` the same way. An unknown model gets a 404 naming why: a switched-off provider, a disabled group or an empty group. Otherwise it names up to three ids nearest to what was asked (`provider.Closest`: words of a model's display name count before words of its id, and a provider's id or name only alongside them, so "Zen-Space-Bunny" is told `opencode-zen-free/space-bunny-free`, MOMO on Discord), then the ways a model can be named, then every id (`unknownModel`; chat and embeddings). | [`gateway.go`](../../internal/gateway/gateway.go), [`internal/provider/group.go`](../../internal/provider/group.go), [`internal/provider/flat.go`](../../internal/provider/flat.go), [`internal/provider/claudedash.go`](../../internal/provider/claudedash.go) |
 | Candidates | `plan` lists one provider's candidates: one per key or account on, then each `Fallback` model, with resting ones last (`restLast`). `planGroup` and `planLevel` weigh a group's members together. A nested group plans by its own routing (#576). So does a member whose provider routes other than Smart (`ownRouting`): weighed as one by its first not resting (`firstAwake`), tried whole in its own order; `leastHeld` leaves such a group's order alone too. A provider on Smart, or routed as the group is, is pooled with the group's other keys and accounts. `group_own_routing_test.go`. A member's own fallbacks are not the group's. | [`fallback.go`](../../internal/gateway/fallback.go) |
 | Order of keys and accounts | `Routing`: smart (""), `order`, `rotate`, `usage` (least used, with an `usageHalfLife` of 1h), `pace` or `weight` (`weightedFirst`). Smart, `usage` and `pace` weigh a subscription by its allowance (`allowances`), and a key by its own usage windows when magpie reads them (`keyAllowance`: a sub2api key given a 5-hour, day or 7-day limit, or a key bought as a plan, such as Kimi Code's or a GLM Coding Plan's); any other key has none. A group routed `weight` (#1910) takes its members, not their keys, by smooth weighted round robin: `planLevel` makes each model member (its keys ordered by its own provider's routing) and each nested group one unit, and `weightedUnits` puts the round's pick (`group/<id>`, keyed by the member's spelling, `Group.Weights`, 1 if unset) first and the rest in member order for failover; a unit whose head rests leaves the round, and a kept conversation moves the round's charge to the member that kept it (`wrrSeat`, `wrrMove`). A lone key or account is weighed against nobody, but what it has left is still read into the trace (`weighRouted`), so the Routing page shows it as it does for several (#1016); all but used up, it keeps its conversation rather than being said to move (`affine`). A failure rests a candidate (`failure`, `failureOf`). A lone key or account is weighed against nobody, but what it has left is still read into the trace (`weighRouted`), so the Routing page shows it as it does for several (#1016); all but used up, it keeps its conversation rather than being said to move (`affine`). A failure rests a candidate (`failure`, `failureOf`). | [`routing.go`](../../internal/gateway/routing.go), [`weighted.go`](../../internal/gateway/weighted.go), [`internal/provider/routing.go`](../../internal/provider/routing.go) |
 | Limits | Each key or account (a candidate's `who()`) has at most `MaxConcurrency` requests out at once (its own `AccountConcurrency` over it); one more waits in its lane's queue, bounded by `QueueLimit` and `QueueWait` and turned away with a 429 past either (`lanes.take`). `MaxRPM` (coeo91 on Discord: OpenRouter's free models take 20 a minute) bounds how many requests it sends the vendor in any rolling 60 seconds (`rpms`), counting each for a second more (`rpmSlack`), since the vendor counts a request when it arrives and the first on a new connection arrives later by its dial: one more waits for room in the minute, in the order they came, after it has its slot and right before it is sent. A wait that would be longer than 2 minutes (or the provider's `QueueWait`, when shorter: `rpmWait`) is turned away at once with a 429 whose `Retry-After` is when the minute has room; nothing rests for it. An agent gone while it waits gives its place back. Every request that reaches the vendor counts: each try of the candidate loop (a retry, the next key, a fallback) waits in `serve`, and the requests a try makes on the way and the gateway's own asks (count_tokens, System One's decisions, embeddings, drawing, Kimi's search) are counted by `rpmTransport` on `s.client` (`metered`, `paidFor`). count_tokens never waits: a candidate with no room is skipped, and the local estimate answers. A full lane or a minute with no room gives way to a ready key or account of the provider or the group (`laneMate`, `ready`); a fallback is never asked for want of either. A plugin's account sends through its own transport, so only its tries are counted, not a plugin's own extra requests. Set in the provider editor (Concurrency, Requests per minute, Queue size, Queue wait) or with `magpie provider account-concurrency`, `queue` and `rpm`; a subscription's are kept with its picks, and every account of it keeps them, those on beside the first as well (`withPicks`, called by `All` and `AlsoOn`; #1899: a second WorkBuddy AI account had none, and queued 62s with the wait set to 1s). | [`concurrency.go`](../../internal/gateway/concurrency.go), [`rpm.go`](../../internal/gateway/rpm.go), [`internal/provider/concurrency.go`](../../internal/provider/concurrency.go) |
diff --git a/internal/agent/claude.go b/internal/agent/claude.go
index 0e2b554a..57b45ae6 100644
--- a/internal/agent/claude.go
+++ b/internal/agent/claude.go
@@ -2253,7 +2253,8 @@ var claudeManaged = func() string {
 // StandIn is the model Claude Code is set to use in place of one it named
 // that magpie doesn't serve: claude-haiku-4-5-… for a title or a small
 // task goes to its haiku tier's model, and a name of no tier to its main
-// model. For Codex, the model it is set to (codexStandIn). "" when the
+// model. For Codex, the model it is set to (codexStandIn), in a WSL
+// distro the distro's config names (wslCodexStandIn). "" when the
 // agent isn't routed through magpie or is neither. For gateway.StandIn.
 func StandIn(agent, model string) string {
 	if agent != "claude" && agent != "codex" {
@@ -2264,7 +2265,11 @@ func StandIn(agent, model string) string {
 		return ""
 	}
 	if agent == "codex" {
-		return codexStandIn(filepath.Join(here(home).codexHome(), "config.toml"))
+		if m := codexStandIn(filepath.Join(here(home).codexHome(), "config.toml")); m != "" || runtime.GOOS != "windows" {
+			return m
+		}
+		// a Codex in a WSL distro is known by the same client
+		return wslCodexStandIn()
 	}
 	if m := claudeStandIn(filepath.Join(here(home).claudeDir(), "settings.json"), model); m != "" || runtime.GOOS != "windows" {
 		return m
diff --git a/internal/agent/wsl.go b/internal/agent/wsl.go
index 525a423e..258e350e 100644
--- a/internal/agent/wsl.go
+++ b/internal/agent/wsl.go
@@ -1099,24 +1099,32 @@ func wslLastSeen(name, key string) string {
 	return ""
 }
 
-// wslClaudeStandIn is StandIn for a Claude Code in a WSL distro routed
-// through magpie: the first, of the distros running now, whose
-// settings.json has a stand-in. Only magpie's memory of them and which run
-// (wslRunningLocked) are asked — nothing is probed, and a stopped distro
-// is never opened.
-func wslClaudeStandIn(model string) string {
+// wslReady are the distros running now that the probe found kind in, each
+// with its mirrored networking settled, ready for a read of its files.
+// Only magpie's memory of them and which run (wslRunningLocked) are
+// asked — nothing is probed, and a stopped distro is never opened.
+func wslReady(kind string) []distro {
 	wsl.Lock()
 	wslRunningLocked()
 	var ds []distro
 	for _, n := range wsl.names {
-		if d := wsl.seen[n]; d != nil && wsl.running[n] && wslKindOf("claude").found(*d) {
+		if d := wsl.seen[n]; d != nil && wsl.running[n] && wslKindOf(kind).found(*d) {
 			ds = append(ds, *d)
 		}
 	}
 	wsl.Unlock()
 	cfg := wslConfig()
-	for _, d := range ds {
-		d.mirror(cfg)
+	for i := range ds {
+		ds[i].mirror(cfg)
+	}
+	return ds
+}
+
+// wslClaudeStandIn is StandIn for a Claude Code in a WSL distro routed
+// through magpie: the first, of the distros running now, whose
+// settings.json has a stand-in.
+func wslClaudeStandIn(model string) string {
+	for _, d := range wslReady("claude") {
 		path := filepath.Join(d.local(d.Home), ".claude", "settings.json")
 		if m := claudeStandInAt(path, model, d.base()); m != "" {
 			return m
@@ -1125,6 +1133,19 @@ func wslClaudeStandIn(model string) string {
 	return ""
 }
 
+// wslCodexStandIn is StandIn for a Codex in a WSL distro routed through
+// magpie: the first, of the distros running now, whose config.toml has
+// magpie as its provider, as this machine's codexStandIn reads it.
+func wslCodexStandIn() string {
+	for _, d := range wslReady("codex") {
+		path := filepath.Join(d.local(d.Home), ".codex", "config.toml")
+		if m := codexStandIn(path); m != "" {
+			return m
+		}
+	}
+	return ""
+}
+
 // wslList is the names wsl.exe lists with args; ok is false when it
 // couldn't say (no WSL, or none installed).
 func wslList(args ...string) (names []string, ok bool) {
diff --git a/internal/agent/wsl_codex_stand_test.go b/internal/agent/wsl_codex_stand_test.go
new file mode 100644
index 00000000..158666b1
--- /dev/null
+++ b/internal/agent/wsl_codex_stand_test.go
@@ -0,0 +1,87 @@
+package agent
+
+import (
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"testing"
+)
+
+// codexDistroHome is a distro's / in a temp dir with a user whose ~/.codex
+// holds config (none when ""); magpie's own HOME is another temp dir.
+func codexDistroHome(t *testing.T, config string) (root, home string) {
+	t.Helper()
+	syncHome(t)
+	root = t.TempDir()
+	home = filepath.Join(root, "home", "me")
+	os.MkdirAll(filepath.Join(home, ".codex"), 0o755)
+	if config != "" {
+		os.WriteFile(filepath.Join(home, ".codex", "config.toml"), []byte(config), 0o644)
+	}
+	return root, home
+}
+
+// A Codex in a running distro, routed through magpie, stands in for a model
+// it names that magpie doesn't serve, as this machine's does and a Claude
+// Code in the distro does (wslClaudeStandIn): the first distro running now
+// whose config.toml has magpie as its provider. One whose config isn't
+// magpie's has none.
+func TestWSLCodexStandIn(t *testing.T) {
+	root, home := codexDistroHome(t, "")
+	cfg := filepath.Join(home, ".codex", "config.toml")
+	fakeWSL(t, "Debian\r\n", "Debian\r\n", map[string]string{
+		"Debian": "home:/home/me\ndir:.codex\nroute:default via 172.20.0.1 dev eth0\n",
+	}, map[string]string{"Debian": root})
+	ds := wslDistros()
+	if len(ds) != 1 || !ds[0].Running {
+		t.Fatalf("%+v", ds)
+	}
+	os.WriteFile(cfg, []byte("model_provider = \"magpie\"\nmodel = \"relay/main\"\n"), 0o644)
+	if got := wslCodexStandIn(); got != "relay/main" {
+		t.Fatalf("stand-in: %q", got)
+	}
+	os.WriteFile(cfg, []byte("model = \"gpt-5.5\"\n"), 0o644)
+	if got := wslCodexStandIn(); got != "" {
+		t.Fatalf("not magpie's provider: %q", got)
+	}
+}
+
+// A distro that has stopped since magpie saw it running is never opened for
+// a stand-in, however wired its config on disk is (da5f7a811: a `wsl
+// --shutdown` is not undone by background work).
+func TestWSLCodexStandInSkipsStopped(t *testing.T) {
+	root, home := codexDistroHome(t, "model_provider = \"magpie\"\nmodel = \"stopped/model\"\n")
+	cfg := filepath.Join(home, ".codex", "config.toml")
+	before, err := os.Stat(cfg)
+	if err != nil {
+		t.Fatal(err)
+	}
+	seen := map[string]*distro{
+		"Debian": {Name: "Debian", Home: "/home/me", Root: root, Has: map[string]bool{"dir:.codex": true},
+			Values: map[string]string{"model": "stopped/model"}},
+	}
+	b, err := json.Marshal(seen)
+	if err != nil {
+		t.Fatal(err)
+	}
+	os.MkdirAll(filepath.Dir(wslStatePath()), 0o755)
+	os.WriteFile(wslStatePath(), b, 0o600)
+	other := t.TempDir()
+	fakeWSL(t, "Debian\r\nOther\r\n", "Other\r\n", map[string]string{
+		"Other": "home:/home/o\ndir:.codex\n",
+	}, map[string]string{"Other": other})
+	ds := wslDistros()
+	if len(ds) != 2 || ds[0].Name != "Debian" || ds[0].Running || ds[1].Name != "Other" || !ds[1].Running {
+		t.Fatalf("%+v", ds)
+	}
+	if got := wslCodexStandIn(); got != "" {
+		t.Fatalf("stand-in from a stopped distro: %q", got)
+	}
+	after, err := os.Stat(cfg)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !after.ModTime().Equal(before.ModTime()) || readFile(cfg) != "model_provider = \"magpie\"\nmodel = \"stopped/model\"\n" {
+		t.Fatal("a stopped distro's config was touched")
+	}
+}
-- 
2.50.1 (Apple Git-155)
```
