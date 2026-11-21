# gateway: 一个 *.localhost 子域的 Origin 免网关 key 花用户订阅——WebKit 不自己解析它（#2242 的兄弟面）

## 现象

`corsGuard`/`foreignPage`（internal/gateway/cors.go）把**任何**以 `.localhost` 结尾的 http(s) Origin 当作「这台电脑上的页面」放行，理由写在注释里：「browsers resolve it to loopback」。这个理由对 Chrome/Firefox 成立（引擎自己有规则，`*.localhost` 一律按 loopback 解析，根本不问 DNS——本机实测：Chromium for Testing 1234 直接加载到了 `http://foo.localhost:<端口>` 上只绑 127.0.0.1 的服务），**对 WebKit 不成立**：Safari 和其它 WebKit 视图把 `*.localhost` 交给系统 resolver（WebKit bug 160504，macOS 15 及更早未修，26 才在系统层补上）。

于是在会回答这些名字的 resolver 路径上（ captive portal、恶意/办公局域网的 DNS、ISP 泛解析——bug 160504 评论区记有会解析 `*.localhost` 的真实 resolver），攻击者可以让受害者的 Safari 打开 `http://free-gift.localhost/` 这样的**远程页面**，其 `Origin: http://free-gift.localhost` 被 foreignPage 豁免 → corsGuard 只对 `origin == "null"` 要 key → 无 key 的「simple」text/plain POST 直达 127.0.0.1:3425，订阅被盲花——和 #2242 沙盒化 iframe 是同一个洞，从隔壁的门进来。

**影响面（如实说）**：暴露人群是 macOS 15 及更早系统上的 Safari/WebKit 用户 + 网关在默认 loopback 运行；攻击前提是受害者路径上有个会应答 `*.localhost` 的 resolver + 受害者点开这个 http 页面。Chrome/Firefox 用户不可由此到达（引擎不问 DNS，实测）。无 CORS 头、帧读不到回包，与 #2242 同为「盲花」。

## 最小复现

`TestLocalhostSubdomainNeedsAKey`（补丁新增）在 `c20bb76c4` 上失败——无 key 的 `http://evil.localhost` POST 被照常应答并打到假厂商：

```
--- FAIL: TestLocalhostSubdomainNeedsAKey (1.04s)
    cors_test.go:444: POST /v1/chat/completions from https://free-gift.localhost with no key: 200 … {"choices":[…]}
    cors_test.go:449: a localhost subdomain with no key reached the vendor 15 times
FAIL
```

12 个「无 key + *.localhost 子域」的 路由×Origin 组合全部 200/直达，vendor 被打 15 次。

## 根因

`internal/gateway/cors.go`：

```go
host := strings.ToLower(u.Hostname())
if host == "localhost" || strings.HasSuffix(host, ".localhost") {
    return false // foreignPage 豁免：browsers resolve it to loopback ← 对 WebKit 为假
}
```

而 corsGuard 的 key 门只看 `origin == "null"`（:48）。`*.localhost` 子域既不在 foreignPage 的 403 里、也不在 null 的 key 门里，两头落空。

## 修法

与 #2242 对 `null` 的裁决同构：非 app 名的 `*.localhost` 子域（`localhostSubdomain()`）与 `null` 同等对待——**无启用网关 key 时 403**，有 key 照常（本地 `*.localhost` 开发页诚实持 key 不受影响，只是和 file:// 页一样要付 key）。`http://tauri.localhost`、`http://wails.localhost`（c20bb76c 特意保留 keyless 的两个 Windows webview 名）和 `localhost` 本名（本地 dev server）不动，无回归。

**留一条给维护者裁定的残余**：在会应答 `*.localhost` 的 resolver 路径上，攻击者的 DNS 同样能应答 `tauri.localhost`/`wails.localhost` 这两个名字本身——若要彻底关死，这两个名字也得进 key 门，代价是 Windows 上 Tauri/Wails 应用的 keyless 插件调用（c20bb76c 刚选择保留的行为）。本补丁取不回归的那一半；严格那一半是两行改动，请维护者定夺。

文档同步：gateway-routing.md 的 HTTP surface 行补了这句话；cors.go 的两段注释改写为按引擎区分的说法。

## 验证

| 步骤 | 结果 |
| --- | --- |
| `TestLocalhostSubdomainNeedsAKey` 在 `c20bb76c4`（stash 修复文件回红） | FAIL：无 key 200、vendor 被打 15 次 |
| 打补丁后同测试（403+`gateway key` 字样、无 CORS 头、vendor 0 次；带 key 200；tauri/wails/localhost 本名照旧） | PASS |
| #2242 的 `TestOpaqueOriginNeedsAKey` / `TestForeignPagesRefused` / `TestCORS*` / `TestReboundPageRefused` / `TestLANGuard` | PASS（照旧） |
| `go test -tags nogui ./internal/gateway/` 全包（Sink+CORS 两补丁，rebase 到 `1ad60446f` 后复跑） | ok（317s / 281s） |
| `-race -count=2`（新测试 + 三个 cors 测试） | ok |
| `gofmt -l internal/` | 空 |
| `go vet -tags nogui ./internal/gateway/`；`GOOS=linux go vet -tags nogui ./...`；`GOOS=windows go vet ./...` | 干净 |
| `go build -tags nogui`；`GOOS=linux go build -tags nogui`；`GOOS=windows go build` | ok |
| patch 独立可上：`git apply --check`（worktree 于 `c20bb76c4`，与嵌套组 Sink 的 patch 互不依赖） | ok |

分支：`hunt22-x2-localhost-origin-key`（`8a92be50`，基于 `1ad60446f`；红测试最初在 `c20bb76c4` 上复现，rebase 只动了基座，cors.go 未变）——https://github.com/ggbdpq/magpie/tree/hunt22-x2-localhost-origin-key

**没跑什么**：真机 Safari + 真 captive 网络（本环境 Playwright WebKit 起不来，WebKit 行为以 bug 160504 为据 + Chromium 反证实测）；Firefox 未本机实测（其硬解析见 Mozilla bug 1433933）；Windows 侧 WebKit 引擎未测。

<details>
<summary>patch（git format-patch -1 --stdout，-U1 上下文）</summary>

```text
From 8a92be503998b2f08d5a3d3d50324bc0e073e357 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 03:31:32 +0800
Subject: [PATCH] gateway: a page at a localhost subdomain pays with a gateway
 key, as Origin null does
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

What changed: corsGuard holds an http(s) Origin at a subdomain of
localhost — other than tauri.localhost and wails.localhost, the two an
installed app's webview serves itself at on Windows — to an enabled
gateway key, answered 403 without one, the way "null" is judged since
#2242. Chrome and Firefox resolve *.localhost to loopback by a rule of
their own, but Safari and other WebKit views ask the configured DNS for
the name (WebKit bug 160504, unfixed through macOS 15), and a resolver
that answers serves the page from anywhere — so the exemption handed
every foreign page that can get such a name answered the same keyless
spend "null" did. foreignPage still passes the origin (a local page
holding it honestly keeps working, with a key); its comment and the
routing doc's HTTP surface row say what is judged now.

Run: TestLocalhostSubdomainNeedsAKey fails on a6d9b8b0 (a no-key POST
from http://evil.localhost is answered 200 and reaches the vendor 15
times) and passes with it; TestOpaqueOriginNeedsAKey,
TestForeignPagesRefused, TestCORS*, TestReboundPageRefused, TestLANGuard
and go test -tags nogui ./internal/gateway/ stay green; -race -count=2 on
the four cors/sink tests green; gofmt -l clean; go vet -tags nogui,
GOOS=linux go vet -tags nogui and GOOS=windows go vet clean; go build,
GOOS=linux go build -tags nogui and GOOS=windows build ok.
---
 docs/subsystems/gateway-routing.md |  2 +-
 internal/gateway/cors.go           | 51 +++++++++++++++----
 internal/gateway/cors_test.go      | 78 ++++++++++++++++++++++++++++++
 3 files changed, 120 insertions(+), 11 deletions(-)

diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index bb2c2edf..016f387b 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -30,3 +30,3 @@ backfilled; see [Gateway Session Aggregation](gateway-sessions.md).
 | TLS | `--tls-cert`/`--tls-key` (`MAGPIE_TLS_CERT`, `MAGPIE_TLS_KEY`) make `ListenAndServe`, `Relisten` (both through `Server.listen`) and `magpie web`'s page (`ServeTLS`) wrap the listener in `tlsListener`. A connection from another computer is `tls.Server` at once, so its plain HTTP gets net/http's 400. One from this computer (`fromThisComputer`: loopback, or a peer address equal to the local one) is sniffed on its own goroutine, 10s at most (`sniffWait`), and 0x16 makes it TLS, so `URL()`, the agents, MCP servers, `ServedBy` and the healthcheck keep `http://127.0.0.1`. `certFiles.get` reloads the pair when either file's mtime or size changes; a pair that doesn't load keeps the one served (logged once per change). `tlsConfig` refuses half a pair or files that don't load before binding. HTTP/1.1 only over TLS (hijack, Codex's websocket). `Scheme()` gives the scheme of `LANURLs`, a scheme-less `MAGPIE_PUBLIC_URL` and the page's network links. Host and Origin checks (`foreignPage`, `rebound`) don't depend on the scheme. | [`tls.go`](../../internal/gateway/tls.go), [`lan.go`](../../internal/gateway/lan.go) |
-| HTTP surface | `Handler` routes `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (each also without `/v1`), `/v1/models`, Gemini's `/v1beta/models/…`, the Codex backend path, `/v1/codex/models` (Codex's catalog shape for a Codex elsewhere with a gateway key, `codexCatalog`, kept to the key's models by `keyAllowed`; #1281), `/mcp/{name}`, `/mcp/magpie/web-search` and `/mcp/magpie/vision` (magpie's own web search and image recognition as MCP servers, below) and the `/v1/magpie/*` status endpoints. `/v1/alpha/search` (also without `/v1`, and on the Codex backend path for a magpie model) is Codex's web.run search (`alphaSearch`, `codex_search.go`): a ChatGPT account's model goes to the ChatGPT backend's `/alpha/search` on the account's sign-in, the next account asked on 401, 403, 429 or 5xx; any other model's `search_query` is searched by `webSearch`, and when nothing answers the reason is a 200 with `output`, since Codex ends the turn on any failed web.run (anton on Discord). A GET on `/v1/responses` (a client opening Responses over a WebSocket) is answered 426, a plain one 405: Responses is relayed over HTTP only. Every route is wrapped in `counted`, `corsGuard`, `callerGuard`, `withCaller` and `keyLimited`; `/v1/messages`, `/messages` and `/v1/messages/count_tokens` in `keepsSignIn` too. `corsGuard` (#1051) serves CORS only to the origins listed in Settings › Network › Web pages (`settings.CORSOrigins`, cleaned to `scheme://host[:port]` by `settings.CleanOrigins`, which refuses a wildcard). A browser extension's own pages, popup and service worker are listed the same way by their origin, which is the browser's scheme and the extension's id: `chrome-extension://<id>` (Chromium, the id 32 letters a–p), `moz-extension://<uuid>` (Firefox, the Internal UUID about:debugging shows, not the add-on id) and `safari-web-extension://<uuid>` (Safari, which picks a new UUID on each launch, so a listing lasts until Safari restarts); the id must have that browser's shape, cased any way, and nothing else is taken — no bare scheme, no wildcard, no path (SkyAerope on Discord: an extension without host permissions is held to CORS like a page). A content script's fetch carries the page's origin, not the extension's. A listed extension is treated exactly as a listed page, below; one not listed passes as before (other schemes, below) with no CORS headers. For a listed origin it answers the preflight (204) and adds `Access-Control-Allow-Origin`, and every other request from it needs an enabled gateway key (`access.Authenticate`), even on loopback, or gets a 401. It takes the key from the caller `lanGuard` recorded too, since on the running server `lanGuard` has already put magpie's own token in the key's place. Any other web page is refused 403 on every route (`foreignPage`): on loopback a call needs no key and the body's Content-Type isn't checked, so a page the user visits could otherwise send a "simple" `text/plain` POST and spend their subscriptions blind. Only an `http`/`https` Origin is judged, and one on this computer (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, any port) or the request's own origin (its host and port equal to `Host`, such as a page on the gateway's LAN address) passes, as does usemagpie.ai on `/v1/magpie/omarchy`. Other schemes (`app://`, `file://`, `tauri://`, `vscode-webview://`, `chrome-extension://`) come from desktop apps, webviews and extensions that don't enforce CORS, and pass keyless as before; `null` is not one of them, since any web page sends it from a sandboxed frame and an opened file sends it too, so a call with it needs an enabled gateway key as a listed origin's does, and is answered 403 without one (no CORS headers either way, so a frame or a local page still reads no reply). A request with no Origin (every agent's) passes through with no CORS headers, as before. A page whose own name resolves to 127.0.0.1 (DNS rebinding) would count as same-origin here, so `lanGuard` refuses it first (`rebound`, 403): a loopback request carrying a browser's marks (`Origin`, `Sec-Fetch-Site`/`Sec-Fetch-Mode`, a `Mozilla/` user agent) whose `Host` isn't this computer's (an IP, `localhost`, `*.localhost`, a container runtime's name for the host such as `host.docker.internal`, `MAGPIE_PUBLIC_URL`'s or `MAGPIE_ADDR`'s host, the machine's own name) needs an enabled gateway key. Agents send none of those marks and pass under any name. Before any of that, `lanGuard` lets in one request without a key from anywhere: `POST /_magpie/claude-mcp/<token>` with the token of a Claude subscription run now live (`ownCallback`, see [the Claude subscription bridge](claude-subscription-bridge.md)), the run's MCP helper calling back to a `MAGPIE_ADDR` that isn't loopback (#1546). Next, before the key or `rebound` is looked at, the allow list (lc on Discord, magpie in Docker on a public host): with `MAGPIE_ALLOW_IPS` or Settings › Network › Allowed addresses (`settings.AllowIPs`; the variable wins and the page then only shows it) naming IPs and CIDR ranges, a request whose connection (`RemoteAddr`, IPv4-mapped IPv6 unmapped, zone dropped) is outside them is refused 403 naming its address, even with an enabled gateway key (`refuseNotAllowed`). Loopback and this computer's own interface addresses always pass. A forwarding header is never taken for the address, so a proxy or tunnel on this computer passes (it arrives from loopback) and its clients are limited at the proxy. An entry that doesn't parse lets nothing in and is logged once; the list stays on. Settings' list is read with `settings.LoadChecked`: a settings.json that can't be read, or doesn't parse with no last good generation, is unknown, never "no list", so the list read last in this process stays in force (`lastAllow`), and with none read yet only this computer passes, the 403 saying settings.json couldn't be read; logged once. No file, or an empty one, is no list. The Settings page's saves read with `LoadChecked` too and refuse such a file, as `settings.Save` does. `magpie web`'s server is wrapped in the same check (`AllowGuard`). Settings refuses a list that would leave out the address the page saving it is open from (`KeepsOut`); the page names that address, which behind Docker or a proxy is the proxy's, and offers to add it to the refused list (`allowSays`, Mathresearcher on Discord). | [`gateway.go`](../../internal/gateway/gateway.go), [`allow.go`](../../internal/gateway/allow.go), [`internal/settings/allowips.go`](../../internal/settings/allowips.go), [`cors.go`](../../internal/gateway/cors.go), [`codex_catalog.go`](../../internal/gateway/codex_catalog.go), [`internal/settings/origins.go`](../../internal/settings/origins.go) |
+| HTTP surface | `Handler` routes `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (each also without `/v1`), `/v1/models`, Gemini's `/v1beta/models/…`, the Codex backend path, `/v1/codex/models` (Codex's catalog shape for a Codex elsewhere with a gateway key, `codexCatalog`, kept to the key's models by `keyAllowed`; #1281), `/mcp/{name}`, `/mcp/magpie/web-search` and `/mcp/magpie/vision` (magpie's own web search and image recognition as MCP servers, below) and the `/v1/magpie/*` status endpoints. `/v1/alpha/search` (also without `/v1`, and on the Codex backend path for a magpie model) is Codex's web.run search (`alphaSearch`, `codex_search.go`): a ChatGPT account's model goes to the ChatGPT backend's `/alpha/search` on the account's sign-in, the next account asked on 401, 403, 429 or 5xx; any other model's `search_query` is searched by `webSearch`, and when nothing answers the reason is a 200 with `output`, since Codex ends the turn on any failed web.run (anton on Discord). A GET on `/v1/responses` (a client opening Responses over a WebSocket) is answered 426, a plain one 405: Responses is relayed over HTTP only. Every route is wrapped in `counted`, `corsGuard`, `callerGuard`, `withCaller` and `keyLimited`; `/v1/messages`, `/messages` and `/v1/messages/count_tokens` in `keepsSignIn` too. `corsGuard` (#1051) serves CORS only to the origins listed in Settings › Network › Web pages (`settings.CORSOrigins`, cleaned to `scheme://host[:port]` by `settings.CleanOrigins`, which refuses a wildcard). A browser extension's own pages, popup and service worker are listed the same way by their origin, which is the browser's scheme and the extension's id: `chrome-extension://<id>` (Chromium, the id 32 letters a–p), `moz-extension://<uuid>` (Firefox, the Internal UUID about:debugging shows, not the add-on id) and `safari-web-extension://<uuid>` (Safari, which picks a new UUID on each launch, so a listing lasts until Safari restarts); the id must have that browser's shape, cased any way, and nothing else is taken — no bare scheme, no wildcard, no path (SkyAerope on Discord: an extension without host permissions is held to CORS like a page). A content script's fetch carries the page's origin, not the extension's. A listed extension is treated exactly as a listed page, below; one not listed passes as before (other schemes, below) with no CORS headers. For a listed origin it answers the preflight (204) and adds `Access-Control-Allow-Origin`, and every other request from it needs an enabled gateway key (`access.Authenticate`), even on loopback, or gets a 401. It takes the key from the caller `lanGuard` recorded too, since on the running server `lanGuard` has already put magpie's own token in the key's place. Any other web page is refused 403 on every route (`foreignPage`): on loopback a call needs no key and the body's Content-Type isn't checked, so a page the user visits could otherwise send a "simple" `text/plain` POST and spend their subscriptions blind. Only an `http`/`https` Origin is judged, and one on this computer (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, any port) or the request's own origin (its host and port equal to `Host`, such as a page on the gateway's LAN address) passes, as does usemagpie.ai on `/v1/magpie/omarchy`. Other schemes (`app://`, `file://`, `tauri://`, `vscode-webview://`, `chrome-extension://`) come from desktop apps, webviews and extensions that don't enforce CORS, and pass keyless as before; `null` is not one of them, since any web page sends it from a sandboxed frame and an opened file sends it too, so a call with it needs an enabled gateway key as a listed origin's does, and is answered 403 without one (no CORS headers either way, so a frame or a local page still reads no reply). A page at a subdomain of localhost other than `tauri.localhost` and `wails.localhost` — the two an installed app's webview serves itself at on Windows — needs a key the same way (`localhostSubdomain`): Chrome and Firefox resolve `*.localhost` to loopback by a rule of their own, but Safari and other WebKit views ask the configured DNS for it (WebKit bug 160504), and a resolver that answers serves the page from anywhere. A request with no Origin (every agent's) passes through with no CORS headers, as before. A page whose own name resolves to 127.0.0.1 (DNS rebinding) would count as same-origin here, so `lanGuard` refuses it first (`rebound`, 403): a loopback request carrying a browser's marks (`Origin`, `Sec-Fetch-Site`/`Sec-Fetch-Mode`, a `Mozilla/` user agent) whose `Host` isn't this computer's (an IP, `localhost`, `*.localhost`, a container runtime's name for the host such as `host.docker.internal`, `MAGPIE_PUBLIC_URL`'s or `MAGPIE_ADDR`'s host, the machine's own name) needs an enabled gateway key. Agents send none of those marks and pass under any name. Before any of that, `lanGuard` lets in one request without a key from anywhere: `POST /_magpie/claude-mcp/<token>` with the token of a Claude subscription run now live (`ownCallback`, see [the Claude subscription bridge](claude-subscription-bridge.md)), the run's MCP helper calling back to a `MAGPIE_ADDR` that isn't loopback (#1546). Next, before the key or `rebound` is looked at, the allow list (lc on Discord, magpie in Docker on a public host): with `MAGPIE_ALLOW_IPS` or Settings › Network › Allowed addresses (`settings.AllowIPs`; the variable wins and the page then only shows it) naming IPs and CIDR ranges, a request whose connection (`RemoteAddr`, IPv4-mapped IPv6 unmapped, zone dropped) is outside them is refused 403 naming its address, even with an enabled gateway key (`refuseNotAllowed`). Loopback and this computer's own interface addresses always pass. A forwarding header is never taken for the address, so a proxy or tunnel on this computer passes (it arrives from loopback) and its clients are limited at the proxy. An entry that doesn't parse lets nothing in and is logged once; the list stays on. Settings' list is read with `settings.LoadChecked`: a settings.json that can't be read, or doesn't parse with no last good generation, is unknown, never "no list", so the list read last in this process stays in force (`lastAllow`), and with none read yet only this computer passes, the 403 saying settings.json couldn't be read; logged once. No file, or an empty one, is no list. The Settings page's saves read with `LoadChecked` too and refuse such a file, as `settings.Save` does. `magpie web`'s server is wrapped in the same check (`AllowGuard`). Settings refuses a list that would leave out the address the page saving it is open from (`KeepsOut`); the page names that address, which behind Docker or a proxy is the proxy's, and offers to add it to the refused list (`allowSays`, Mathresearcher on Discord). | [`gateway.go`](../../internal/gateway/gateway.go), [`allow.go`](../../internal/gateway/allow.go), [`internal/settings/allowips.go`](../../internal/settings/allowips.go), [`cors.go`](../../internal/gateway/cors.go), [`codex_catalog.go`](../../internal/gateway/codex_catalog.go), [`internal/settings/origins.go`](../../internal/settings/origins.go) |
 | Model resolution | `serve` resolves the model the agent asked for: Claude tier stand-ins, a routing group (`provider.GroupFor`: its id, the model's id however a vendor spells it, else the one group whose name it is, unless a provider serves a model by that id), auto stand-ins, the agent's own stand-in (`StandIn`: Codex's config.toml `model` when magpie is its provider, for a name it sends that magpie doesn't serve, such as its auto-review's `codex-auto-review`), itself taken through `GroupFor` and auto stand-ins so a config naming a group bare reaches it, then `provider.Resolve`. A Codex memory call or auto-review (`x-openai-subagent: guardian`, or `codex-auto-review`) that still names no served model goes to the model Codex's last turn was answered on (`codexMemoryStandIn`, per agent and gateway key), so a Codex on magpie through another provider table, a profile or another computer isn't answered 404 (Adam on Discord, `TestCodexAutoReviewReachesItsTurnsModel`). A bare model id several providers serve (MOMO on Discord: `glm-5.3` under opencode-go and a6api) is never refused: with found groups on (the default) `GroupFor` takes it to the group magpie found for it (`auto-<slug>`), its members in the Providers order, routed and failed over as any group, a conversation staying with the member that answered it while its cache is worth it (affinity); with them off, `Resolve` takes the first provider in the Providers order that exposes it, with no fallback. magpie writes only `provider/model` ids into agents' configs (`magpieModels`), so a bare id is one the user wrote. `/v1/models` lists bare ids only when the user asks for them ([Model ids without the provider](#model-ids-without-the-provider)). Every reply says who answered in `X-Magpie-Provider` and `X-Magpie-Model` (`noteMember`), and the usage log and the Routing page keep it. A model id with `~` and no slash that resolves as nothing else is the one served id (a provider's model or a group) whose slashes it spells as `~` (`unflat`, `provider.Unflat`; MiniMax Code's spelling, #1387), taken back in `validateModel` before key limits, middleware and usage see it; two ids spelled alike are neither. A Claude model id whose version is dashed (`relay/claude-opus-4-6-us`, with or without `:level` and `[1m]`) that is not served as spelled is the one served id it dashes (`provider.ClaudeUndashed`; the spelling magpie gives Claude Code, which reads a dotted version as Claude Opus 4), taken back in `validateModel` and `unprefixed` the same way. An unknown model gets a 404 naming why: a switched-off provider, a disabled group or an empty group. Otherwise it names up to three ids nearest to what was asked (`provider.Closest`: words of a model's display name count before words of its id, and a provider's id or name only alongside them, so "Zen-Space-Bunny" is told `opencode-zen-free/space-bunny-free`, MOMO on Discord), then the ways a model can be named, then every id (`unknownModel`; chat and embeddings). | [`gateway.go`](../../internal/gateway/gateway.go), [`internal/provider/group.go`](../../internal/provider/group.go), [`internal/provider/flat.go`](../../internal/provider/flat.go), [`internal/provider/claudedash.go`](../../internal/provider/claudedash.go) |
diff --git a/internal/gateway/cors.go b/internal/gateway/cors.go
index 6bb41166..5928b269 100644
--- a/internal/gateway/cors.go
+++ b/internal/gateway/cors.go
@@ -35,5 +35,10 @@ import (
 // which is that same "simple" POST one frame away (a file:// page and an
-// app's webview send it as well). A key, as for a listed origin, still
-// lets such a client through; neither gets CORS headers, so a frame or a
-// local page still sends blind, as before.
+// app's webview send it as well). So is a page at a subdomain of
+// localhost, other than the two Tauri and Wails serve their webviews at:
+// a browser that resolves the name itself keeps such a page on this
+// computer, but Safari and other WebKit views ask the configured DNS for
+// it (WebKit bug 160504), and a resolver that answers serves it from
+// anywhere. A key, as for a listed origin, still lets such a client
+// through; neither gets CORS headers, so a frame or a local page still
+// sends blind, as before.
 func corsGuard(next http.Handler) http.Handler {
@@ -47,5 +52,5 @@ func corsGuard(next http.Handler) http.Handler {
 			}
-			if origin == "null" && !keyedCaller(r) {
-				log.Printf("refused %s %s from Origin: null: a sandboxed frame or a local page, with no gateway key", r.Method, r.URL.Path)
-				writeError(w, provider.Chat, http.StatusForbidden, "magpie doesn't answer a sandboxed frame or a local page (Origin: null) without a gateway key: create one in magpie's Gateway page and send it as Authorization: Bearer <key> (or x-api-key)")
+			if (origin == "null" || localhostSubdomain(origin)) && !keyedCaller(r) {
+				log.Printf("refused %s %s from %s: a sandboxed frame, a local file, or a page a resolver may serve from anywhere, with no gateway key", r.Method, r.URL.Path, origin)
+				writeError(w, provider.Chat, http.StatusForbidden, "magpie doesn't answer a sandboxed frame, a local page (Origin: null) or a page at a localhost subdomain without a gateway key: create one in magpie's Gateway page and send it as Authorization: Bearer <key> (or x-api-key)")
 				return
@@ -90,2 +95,25 @@ func keyedCaller(r *http.Request) bool {
 
+// localhostSubdomain: origin is an http(s) page at a subdomain of
+// localhost other than the two an installed app's webview serves itself
+// at on Windows (http://tauri.localhost, http://wails.localhost). Chrome
+// and Firefox resolve *.localhost to loopback by a rule of their own, so
+// there such a page is this computer's; Safari and other WebKit views ask
+// the configured DNS for it (WebKit bug 160504, unfixed through macOS 15;
+// macOS 26 resolves it below WebKit), and a resolver that answers — a
+// captive portal's, a network's, an ISP's — serves the page from
+// anywhere. corsGuard holds it to a gateway key, as "null": whichever
+// browser holds it, a page that may be elsewhere pays its way.
+func localhostSubdomain(origin string) bool {
+	u, err := url.Parse(origin)
+	if err != nil {
+		return false
+	}
+	if s := strings.ToLower(u.Scheme); s != "http" && s != "https" {
+		return false
+	}
+	host := strings.ToLower(u.Hostname())
+	return strings.HasSuffix(host, ".localhost") &&
+		host != "tauri.localhost" && host != "wails.localhost"
+}
+
 // foreignPage: origin is an http(s) web page that is neither on this
@@ -104,6 +132,9 @@ func keyedCaller(r *http.Request) bool {
 // them: any web page sends it from a sandboxed frame and a local file
-// sends it too, which corsGuard judges (a gateway key, or 403). *.localhost
-// counts as this computer: browsers resolve it to loopback, and Tauri's
-// and Wails' webviews on Windows are http://tauri.localhost and
-// http://wails.localhost, whose HTTP plugins send that Origin outside CORS.
+// sends it too, which corsGuard judges (a gateway key, or 403) — and so
+// is a subdomain of localhost another app's name among them
+// (localhostSubdomain). Tauri's and Wails' webviews on Windows are
+// http://tauri.localhost and http://wails.localhost, whose HTTP plugins
+// send that Origin outside CORS; *.localhost counts as this computer for
+// the browsers that resolve it by their own rule, and corsGuard asks a
+// key of it for the ones that ask the DNS instead.
 func foreignPage(r *http.Request, origin string) bool {
diff --git a/internal/gateway/cors_test.go b/internal/gateway/cors_test.go
index 0a6c22ea..9f59714b 100644
--- a/internal/gateway/cors_test.go
+++ b/internal/gateway/cors_test.go
@@ -385,2 +385,80 @@ func TestOpaqueOriginNeedsAKey(t *testing.T) {
 
+// A page at a subdomain of localhost, other than the two Tauri and Wails
+// serve their webviews at on Windows, is not this computer's whenever the
+// browser cannot tell: Chrome and Firefox resolve *.localhost to loopback
+// by a rule of their own, but Safari and other WebKit views ask the
+// configured DNS for it (WebKit bug 160504, unfixed through macOS 15),
+// and a resolver that answers — a captive portal's, a network's, an
+// ISP's — serves the page from anywhere. Such a page then holds the
+// foreign-page power corsGuard exists against: the simple text/plain POST
+// at a loopback gateway that asks no key, the subscription spent unread.
+// Its Origin is held to an enabled gateway key, as "null" is. Tauri's and
+// Wails' stay keyless, and so do a page at localhost itself and every
+// scheme only an app or an extension can send.
+func TestLocalhostSubdomainNeedsAKey(t *testing.T) {
+	fresh(t)
+	var hits atomic.Int64
+	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		hits.Add(1)
+		w.Header().Set("Content-Type", "application/json")
+		io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`)
+	}))
+	defer up.Close()
+	if err := provider.Save(provider.Provider{ID: "plan", Name: "Plan", Key: "upstream-secret", Chat: up.URL + "/v1", Models: []string{"m1"}}); err != nil {
+		t.Fatal(err)
+	}
+	secret, err := access.Update("add-key", access.Change{Name: "Local page"})
+	if err != nil {
+		t.Fatal(err)
+	}
+	do := func(method, path, origin, key string) *httptest.ResponseRecorder {
+		t.Helper()
+		var body io.Reader
+		if method == "POST" {
+			body = strings.NewReader(chatReq)
+		}
+		r := httptest.NewRequest(method, path, body)
+		r.RemoteAddr = "127.0.0.1:50123"
+		r.Host = "127.0.0.1:3425"
+		r.Header.Set("Origin", origin)
+		r.Header.Set("Sec-Fetch-Site", "cross-site")
+		r.Header.Set("Sec-Fetch-Mode", "no-cors")
+		r.Header.Set("Content-Type", "text/plain;charset=UTF-8")
+		if key != "" {
+			r.Header.Set("Authorization", "Bearer "+key)
+		}
+		w := httptest.NewRecorder()
+		lanGuard(New().Handler()).ServeHTTP(w, r)
+		return w
+	}
+	// a page a resolver serves from anywhere, at any of the subdomains,
+	// spends nothing without a key
+	for _, o := range []string{"http://evil.localhost", "http://evil.localhost:8080", "https://free-gift.localhost"} {
+		for _, p := range []struct{ method, path string }{
+			{"POST", "/v1/chat/completions"},
+			{"POST", "/v1/messages"},
+			{"POST", "/v1/embeddings"},
+			{"GET", "/v1/models"},
+		} {
+			if w := do(p.method, p.path, o, ""); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "gateway key") || w.Header().Get("Access-Control-Allow-Origin") != "" {
+				t.Errorf("%s %s from %s with no key: %d %v %s", p.method, p.path, o, w.Code, w.Header(), w.Body)
+			}
+		}
+	}
+	if hits.Load() != 0 {
+		t.Fatalf("a localhost subdomain with no key reached the vendor %d times", hits.Load())
+	}
+	// with an enabled key it is answered, as a local page holding the
+	// origin honestly is
+	if w := do("POST", "/v1/chat/completions", "http://evil.localhost", secret); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "ok") || hits.Load() != 1 {
+		t.Errorf("with its key: %d %s", w.Code, w.Body)
+	}
+	// answered as before: the two webviews, a page at localhost itself
+	for _, o := range []string{"http://tauri.localhost", "http://wails.localhost", "http://localhost:5173"} {
+		if w := do("POST", "/v1/chat/completions", o, ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "ok") {
+			t.Errorf("%s as before: %d %s", o, w.Code, w.Body)
+		}
+	}
+}
+
 // A browser extension the user listed by its origin (#1051, SkyAerope on
-- 
2.50.1 (Apple Git-155)
```

</details>

同族：#2242（`Origin: null`，已修）、c431225a（DNS rebinding 的 Host 门，同一条 #1051 → d5468283 → c431225a 链的残余）。

合入请保留作者署名（`git am` 即可）。Generated-by: GLM-5.3-Flash (ZCode)
