# #2593 评论返工 · fake-IP 经 loopback 代理保留域名 —— 执行留档

- 触发：h4rk8s 2026-10-20 评论（id 6282584569）——对我们 10-16 的方案给出**实测反例**。
- 分支：`hunt51-a-fakeip-proxy`（worktree `/tmp/magpie-h30`，基 upstream/main `d9c6a60d`）
- 提交：`eb80c5b0`；patch SHA-256 前 16 `2de77572bcea43f7`

## 反例要点（评论原文摘要）

只把 `198.18.0.0/15` 从 `specialNets` 移除**不够**：guard 放行后 `publicTransport` 仍把解析出的地址 pin 住交给代理，而真实代理无法路由 fake-IP（CONNECT by name 成功、CONNECT by fake-IP 失败）。给 `fetchPrivate` 加该段同理——绕过了 guard，pin 还在。

评论给出的窄修法三条件：
1. URL 是域名（非字面量 IP）；
2. 选中的代理是 loopback 字面量地址；
3. 本地解析的**每一个**地址都落在 `198.18.0.0/15`。

并且明确标注安全权衡：该分支把最终解析交给 loopback 代理，magpie 无法独立观测/固定代理内的最终目的地址——这个信任边界必须在设计时说明。

## 实现

`internal/gateway/image_fetch_guard.go`：

- 新谓词 `fakeIPProxy(host, addrs, proxy)`：三条件全真才返回 true（域名、loopback 字面量代理、答案全部落段且非空）。混合答案 / 字面量 / 非 loopback 代理 / 无代理 / 空答案一律 false。
- guard 检查处：`byName` 为真时放行 fake-IP 答案；其余形态照旧拒绝。
- pin 处：`byName` 为真时保留调用方的 hostname（HTTPS 的 CONNECT 与 TLS SNI 都是域名；HTTP 经 HTTP 代理时 authority 取自被检查的 URL，不会被请求自带的 `Host` 顶替）。
- `specialNets` **未动**：字面量、直连、非 loopback 代理、混合答案仍拒绝；重定向逐个复检。

## 验证（全部实测）

| 检查 | 结果 |
|---|---|
| `TestFakeIPThroughALoopbackProxyKeepsTheName`（新，端到端） | 修前 RED（请求未到代理，报 issue 原文「private address」）；修后 GREEN（代理收到域名；HTTPS CONNECT 也是域名） |
| `TestFakeIPProxyPredicate`（新，9 用例表） | 修前 RED；修后 GREEN |
| `TestFakeIPIsNotAnExceptionElsewhere`（新） | 直连 / 字面量仍拒 |
| 消融：`fakeIPProxy` 短路为 false，测试保留 | 同一断言复红；恢复绿 |
| 变异 a（允许非 loopback 代理） | 1 红 |
| 变异 b（允许混合答案） | 1 红（`a mixed answer: true, want false`） |
| 变异 c（允许字面量） | 2 红 |
| 变异 d（允许 nil 代理） | 1 红 |
| 改动触及家族（web_fetch/图片编辑/draw/guard/fetchPrivate） | ok 32.575s |
| `-race` 定向 | ok 15.983s |
| `gofmt -l internal/gateway/` | 空 |
| vet darwin / linux / windows | 全过 |
| build darwin / linux / windows | 全过 |

### 全量 gateway 超时的定性（重要）

- 本机 `go test -tags nogui -p 2 -timeout 45m ./internal/gateway/` 在**我的改动树上超时**（2701.97s）。
- **干净基线 worktree（`/tmp/magpie-h30-base`，无任何改动，`-p 1 -timeout 20m`）同样超时**（1201.807s，goroutine dump 截断）。
- 结论：全量套件在本机负载下超时是**预存问题**（与 #2544/#2108 一类），不是本补丁引入；本补丁的全部 blast radius 家族已单独跑绿。

## 诚实边界

- 本机无真实 Clash TUN / Surge；代理是 `httptest` 替身，resolver 为 fake。h4rk8s 的双机实测是现场证据。
- 未用真实 Surge 复现「CONNECT by name vs by fake-IP」的对比，只在请求层面断言代理收到什么。
- HTTP（非 HTTPS）经代理的分支只断言 authority 取值，未跑真实 HTTP 代理。

## 结局（2026-10-22 追加）

- 维护者 yetone `240f3eb4c` 收编两代 patch（10-16 specialNets 方案 + 本单三条件返工），`Co-authored-by: ggbdpq` 在 commit trailers。
- 实现落共享包 `internal/netguard`（Public/FakeIP/LoonPaired）：保留本单三条件语义（域名+loopback 代理+全落段→按名），新增纯 TUN 直拨分支（TomXPRIME 报告条件：无代理→直拨假地址，dial guard 只放行该地址）、Loon AAAA 配对、图标路径并入 stricter gateway list。
- v0.1.1321（tag `226551d0d`）早于合入 17 分钟，不含修复，下版带；issue 保持 open 等真机确认（TomXPRIME 有 Windows+Clash Verge Rev，h4rk8s 有 Surge）。
- 10-22 复跑（@upstream/main `ef6f3749`，darwin/arm64）：netguard ok 1.252s；`-run 'TestFakeIP'` 三测试 PASS；守卫家族 ok 1.003s。双回复：[TomXPRIME](https://github.com/yetone/magpie/issues/2593#issuecomment-6340919290) / [yetone](https://github.com/yetone/magpie/issues/2593#issuecomment-6340920720)（稿：本目录 2593-reply-*.md）。
