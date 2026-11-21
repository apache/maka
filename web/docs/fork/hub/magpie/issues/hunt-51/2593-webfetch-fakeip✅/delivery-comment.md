## 根因

已定位并修复,分支 `hunt/2593-webfetch-fakeip`(patch SHA `279c436f`,基于 `upstream/main` = `1d6f461a`)。

判定点在 `internal/gateway/image_fetch_guard.go` 的 `specialNets`(现 156 行附近):`198.18.0.0/15`(RFC 2544 benchmarking)在拒绝列表里,`publicAddr` 对解析结果逐地址直判,于是如正文所分析——Fake-IP 模式下每次解析必然落段、必然拒绝。该 guard 由 `ea3dee96` 重写,其后 `image_fetch_guard.go` / `search_fetch.go` 无后续改动,所以 upstream 当前就是这句报错的来源。受影响的不止 `web_fetch`:`fetchPicture`、vendor 图片/视频 URL 下载、imagemcp 都走同一个 guard,Clash TUN 用户应当是全被拒。

## 修法与安全边界

与 `internal/provider/icon.go` 的既有口径对齐(#252 先例):从 `specialNets` 移除 `198.18.0.0/15`,并在注释与 `docs/subsystems/gateway-routing.md` 的 guard 段落写明豁免理由。没有采用"按 hostname 判定而不用解析后 IP"的路——那会拆掉 resolve→check→pin 的 DNS rebinding 防线,重新打开 SSRF 面。放行该段的安全论证与 #252 相同:该段不承载 loopback / RFC 1918 / 链路本地(云元数据)/ CGNAT 上的任何服务;有 TUN 时连接被 TUN 截走、经代理到名字指向的公网主机(直连路径 pin 的假 IP 同样被 TUN 截走,走 magpie 配置的代理时 pin 后的地址发给代理核心、由它映射回域名),无 TUN 时该地址不可路由、连接失败。也就是说 magpie 始终碰不到本机或内网服务,其余全部拒绝判定(loopback、RFC 1918、fc00::/7、169.254/16、100.64/10、文档/保留段等)、每条重定向复检、拨号时二次校验,一概未动。正文建议的更保守变体(字面量 IP 落段仍拒)没有采用:字面量假 IP 在 TUN 里没有 fake-ip 映射、连不出任何东西,区分它只加复杂度,且会与 icon.go 口径不一致——这点留给你判断,如倾向保守我再收。

## 验证

| 检查项 | 结果 |
| --- | --- |
| `TestPublicAddr` 加该段四角为 public、相邻文档段为 private | 修前红(4 处 fail)→ 修后绿 |
| `TestWebFetchReadsANameAtAFakeIPAddress`(新):名字解析到 198.18.5.1 的页面经本地代理(替身 TUN)抓取成功,代理收到 pin 后的假地址而非名字 | 修前红,报错与正文逐字一致("it is at a private address … which web_fetch doesn't read")→ 修后绿 |
| 既有私有拒绝测试(`TestWebFetchOnlyPublic`、`TestEditImageURL*`、`TestPrivateDialer…` 等) | 全绿,拒绝面未松动 |
| `go test -tags nogui -p 2 -count=1 ./internal/gateway/` 全量 | ok(308s) |
| `gofmt -l`(改动三文件) | 空 |
| `go vet -tags nogui`(darwin / GOOS=linux / GOOS=windows) | 全过 |
| build:darwin `go build ./...`;linux / windows `go build -tags nogui ./...` | 全过(darwin 的 cgo/ld 警告为预存) |

未验证项:本机没开 Clash TUN,红绿都是单测构造(假 IP 进判定函数、本地服务器替身隧道代理),没在真实 TUN 环境跑过端到端。

## 请维护者定夺

patch 在 fork 分支 [ggbdpq/magpie `hunt/2593-webfetch-fakeip`](https://github.com/ggbdpq/magpie/tree/hunt/2593-webfetch-fakeip)(单提交 `279c436f`,4 文件 +66/−7,含测试与文档),你直接 cherry-pick 即可;或回复一声我再开 PR,听你的。另外 **#2592 是同一问题的重复单**(同一报告者误发),建议两单择一关闭、另一单随本修复关。

--
本修复由 GLM-5.3-Flash (ZCode) 辅助分析并实现,提交带 `Generated-by: GLM-5.3-Flash (ZCode)` 尾注。
