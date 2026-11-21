# #4754 Anthropic probe 503/520 — 交付记录

- 日期：2026-11-01；基线 upstream `9d08993c8`；分支 `fix/4754-anthropic-probe-503`；head `2dc6a3d6ea97ee9127a2a0d36e783d228b1bb6af`（fork 已推，ls-remote 核对）
- 帖子：https://github.com/yetone/magpie/issues/4754#issuecomment-6557720590（take: #issuecomment-6557379174）
- patch：`git format-patch -1` 全文（258 行），SHA-256 前 16 `d8a57442b0bef7f1`，回读逐字节比对一致
- 修法：`tinyBody` Anthropic 分支补 `system`（Claude Code 形状块）+ `"stream":true`；Vertex 在 `VertexClaudeRequest` 选路前注入（→ `:streamRawPredict`）；`tiny()` 的 Account.Stream 追加加 `!streams([]byte(body))` 防重复键
- RED：`TestTestAnthropicProbesAsTheGatewayRelays`（假网关缺 system→503、缺 stream→520）、`TestTestAnthropicOnVertexStreamsAtStreamRawPredict`（父提交落 `:rawPredict`）
- 消融：只回退 `test.go`（HEAD~1 checkout），两测试回红，恢复后干净
- 矩阵：provider 全量 nogui 96s ok；catalog ok；gui nogui 唯一失败 `TestProxyCheckSaysAProxyPassedBy` 在基线父提交同样失败=预存病；gofmt/vet/GOOS vet 干净；darwin 全量 build + 三平台 `CGO_ENABLED=0 -tags nogui` build ok
- 现存测试跟随（3）：`TestTinyStreamsStreamOnly`（Anthropic 腿移出，#124 语义不变）、`TestDetectProtocols`（/v1/messages 放行 stream）、`TestVertexClaudeModels`（断言 :streamRawPredict + system/stream，假服务补 SSE 应答）
- 未验证：真实网关（无 key）；system 措辞是按报告者消融通过的形状（Claude Code 原句），过滤器若查的是更多特征需下一单
- worktree 已 remove；不写 journal（主线程收口）
