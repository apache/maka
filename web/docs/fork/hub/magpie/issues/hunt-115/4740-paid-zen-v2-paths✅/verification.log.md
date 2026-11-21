# #4740 verification log（本机 darwin/arm64，go1.26）

- 开工 upstream SHA: 9d08993c8bd40de5d002bc364a16be344c5d78fa（2026-11-01 fetch）
- head: 735b4ca9769f62d3846e88dfd9f002f3233b2322（分支 fix/4740-paid-zen-v2-paths，已推 fork，ls-remote 核对一致）
- patch: 4740-paid-zen-v2-paths.patch，SHA-256 前 16 = 8c071e2c06955cda
- RED（改动前，对父提交语义）: TestOpenCodeFreeURL 13 行断言失败（含 paid probe https://opencode.ai/zen/v1/responses）；
  TestOpenCodeGoModelsGoOnTheirOwnAPI / TestZenFreeAtInferenceURL（paid 行 /zen/v1/chat/completions）失败
- GREEN: go test -tags nogui -count=1 ./internal/provider（ok 113.8s）./internal/gateway（ok 567.8s）
- 消融（两 seam 门控退回仅免费，函数保留，测试全保留）：TestOpenCodePaidOnV2Paths、TestOpenCodeGoModelsGoOnTheirOwnAPI、
  TestZenFreeAtInferenceURL（仅 paid 行红、free 行绿）、TestOpenCodeV2URL（仅 paid probe 行红）→ 全部 FAIL，见 ablation-*.txt
- -race 定向: 两包 ok
- gofmt -l internal/: 空
- go vet -tags nogui: darwin/linux/windows 全 0
- go build -tags nogui: darwin（internal/gui 预存 cgo 警告，exit 0）/linux/windows 全过
- POST 前门禁: upstream 9d08993c8..15b035eef（1 提交，无 zen/opencode、无本单文件改动，无需 rebase）
- 线上探测（2026-11-01，均无凭证单次）:
  - 200: /zen/v1/models /inference/v1/models /zen/go/v1/models /inference/go/v1/models
  - 404: /inference/openai/v1/models /inference/go/openai/v1/models /zen/go/openai/v1/chat/completions /zen/go/anthropic/v1/messages /zen/openai/v1/chat/completions /zen/anthropic/v1/messages
  - 400: /zen/v1/chat/completions /inference/openai/v1/{chat/completions,responses} /zen/v1/messages /inference/anthropic/v1/messages /zen/go/v1/chat/completions /inference/go/openai/v1/chat/completions /zen/go/v1/messages /inference/go/anthropic/v1/messages /zen/v1/systemone /inference/systemone/v1/systemone
  - 401: /inference/google/v1beta/models/gemini-3.5-flash:streamGenerateContent（Upstream request failed: Invalid credential） /zen/go/v1/usage /inference/go/v1/usage
  - 410: /zen/v1/models/gemini-3-flash:streamGenerateContent（ModelDeprecated，路径存活）
- 发帖: issuecomment-6558282206 https://github.com/yetone/magpie/issues/4740#issuecomment-6558282206
- 回读: 与稿件逐字节一致（GitHub 尾部补 1 换行），五项自检（AI-written / Co-authored-by: ggbdpq / SHA-256 first 16 / git am applies it as is / Branch with the commit）各 1
