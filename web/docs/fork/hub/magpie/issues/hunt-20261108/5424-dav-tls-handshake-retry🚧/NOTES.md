# 5424 infincloud WebDAV 报 TLS handshake timeout 但实际备份成功（误报面）

- 判定：备份确实成功（截图B magpie.magpie-backup 91.34KB 当日 9:08）；失败的是后续 sync 的 GET 读（截图A），错误被写成"同步失败"——误报。
- 根因：stallTransport.RoundTrip 对 TLS 握手超时一次判死。握手完成前 HTTP 请求一个字节都没写出（Go 在握手后才写请求），请求从未到达服务器。
- 修：握手超时的请求在新连接重发一次、watchdog 满预算重置——与 gateway #5519（d4a6e9315，请求写出前死于 EOF 重发）同形。两道护栏：无 GetBody 的 body 不重发；请求写出后的 stall 不重发（服务器可能已收到）。安全面：WebDAV GET/PUT/PROPFIND、S3 条件写 PUT、GitHub blob POST（内容寻址）皆可安全重复。
- RED：stall_handshake_test.go 4 测试（GET 重发/PUT body 重发/无GetBody 不重发/stall 后不重发）。消融=handshakeTimeout 条件。实现中曾把 done()（cancel ctx）放进重试路径——fake 测不出，加强测试断言第二次调用 ctx 未取消后修复。
- 矩阵：davsync nogui 全包绿 48s；stall 域 -race 绿 15s；gofmt/vet darwin+linux/windows 净；build nogui x3 绿；cli 定向绿 1.3s；全仓 go test ./... not run（照实列）。
- head 3684d2087c7ad63024bab62f153ddc90773650cf（基于 0fc3455e2）；patch sha256 前16 697406b41e26a726（7.9KB）
- 事故记录：amend 修 message typo 后误推旧 sha，force-with-lease 钉旧值 839c971ff 重推 3684d2087，ls-remote 复核一致。
- take: https://github.com/yetone/magpie/issues/5424#issuecomment-6716430091
- PATCH 帖: https://github.com/yetone/magpie/issues/5424#issuecomment-6716485494
- 回读: author=ggbdpq, 围栏成对, patch 字节一致, sha/head/attribution/尾注全在（7/7 PASS）
