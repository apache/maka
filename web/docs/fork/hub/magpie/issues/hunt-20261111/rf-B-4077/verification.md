# rf-B-4077 验证记录（2026-11-12，基=e6bf4adf1）

- 分支 hunt-20261111-rf-4077 @ d23ec8a08023a6d791（author=ggbdpq；cherry-pick 自 fix/4077-tls-pq-keyshare@238488c40，upstream_transport.go 冲突语义解：ClassicalRetry 包装保留+内层并入上游新 stallGuard）
- patch sha256 前16: b704e3ef5caaffba
- RED（tip 基线+gateway 两测试）: TestTLSHandshakeTimeoutGoesAgainWithoutThePostQuantumShare / TestPostWithABodyGoesAgainWholeWithoutTheShare 双红（各 45s 超时路径=握手超时不重试）——gateway 测试走公开 upstreamTransport 路径基线可编译
- netproxy 侧测试直引 ClassicalRetry 新符号→基线 build failed 不算红；RED 由 gateway 公开路径承载
- GREEN: gateway 定向 ok 60.5s / netproxy 全包 ok 9.0s
- 消融×2：①netproxy HandshakeTimedOut 恒 false→TestClassicalRetrySendsAgain/TestAnUnreplayableBodySaysWhy 红→恢复绿 ②gateway Alt=nil（摘 classical 供给）→两 gateway 测试红（30s）→恢复绿（首次消融试 struct 剥壳 build failed 改 Alt=nil 等效形态）
- am 回放：/tmp/mg-50B-base reset --hard e6bf4adf1 git am 即进，树零差异，author=ggbdpq
- gofmt/vet 净；GOOS=linux/windows(nogui) build OK
- 兄弟面：ClassicalRetry 消费点×2（gateway upstream_transport.go:39 vendor 出向=主面 + netproxy.go:41 DefaultClient 全局面）均 patch 内；HandshakeTimedOut 唯一定义唯一消费；"TLS handshake timeout" 在 fallback.go transportWords/offline.go connFailed 词表=失败分类面有意不改（ErrPQHandshake.Error 保留原词前缀，分类仍命中）
- Not verified: 报告者真实网络（PQ ClientHello 被中间盒丢弃的真机形状——fixture 模拟握手超时）
- 待补：全量 gateway+netproxy 与 race 结果（后台跑）
