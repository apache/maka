# #5535 验证记录（车道 M3，worktree /private/tmp/mg-5535，分支 fix/5535-tool-call-wording）

基线 upstream/main `41630545143c783b421a2177667510f11ab7b020`（kiro: the mover installs 0.1.27…）。

## TDD（精确测试名）

- 新测试：`TestClaudeCutStreamMidToolCallWordedToRetry`（internal/gateway/claude_cut_stream_test.go:205）
- 场景=报告者现场：message_start（cutStart，5 out/467708 cache_write）→ client 工具 `mcp__magpie__Write` content_block_start → input_json_delta 半截参数 → message_stop（无 message_delta）
- RED（父基线，产品无后缀）：`--- FAIL: TestClaudeCutStreamMidToolCallWordedToRetry`，raw 中事件 `{"error":{"message":"Claude Code's stream from Anthropic was cut short after the reply had begun","type":"api_error"}}`，t.Fatalf=the failure says nothing a client's own retry reads as transient
- GREEN（修复后）：`ok github.com/yetone/magpie/internal/gateway`（-run 'TestClaudeCutStream' 全家族同绿）

## 消融回红（先提交 05145df06，基线=父提交，只退产品文件）

- `git checkout HEAD~1 -- internal/gateway/claude_subscription.go` → 测试回红（同 RED 原文路径）
- `git checkout HEAD -- …` 恢复 → 回绿；工作树干净
- 消融只退产品文件，测试保留；变异点=语义分叉行（emit 的 Text 拼接）

## 矩阵

| 项 | 结果 |
| --- | --- |
| 定向 `TestClaudeCutStream*` 7 测试 | 绿 |
| gofmt -l internal/gateway | 空 |
| go vet -tags nogui ./internal/gateway（darwin） | 过 |
| go vet -tags nogui ./internal/gateway（GOOS=windows GOARCH=amd64） | 过 |
| go build -tags nogui ./...（darwin） | 过 |
| go build -tags nogui ./...（GOOS=windows GOARCH=amd64） | 过 |
| 预存红定向对照（TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy/TestBrowserKeyOffClosesItsBrowser，单独 -run） | 全过（本机当前非红态） |
| gateway 全包 nogui -race -timeout 25m | 超时（1500.7s 撞 25m 整，超时时 TestUnroutedProgressingUploadOutlastsMost 才跑 4s；-race 下本机套件 >25m） |
| gateway 全包 nogui -race -timeout 45m | 待补 |
| linux wails | NOT-RUNNABLE（darwin 无 wails 环境，未跑） |

## 全包 25m 超时跑中的唯一真失败=预存红

- `--- FAIL: TestBrowserKeyOffClosesItsBrowser`：`race detected`，堆栈=internal/gateway/browser_key_test.go:186-210 ↔ internal/gateway/browser.go:421 watchKey——两文件与本提交无关（HEAD~1..HEAD 只触 claude_subscription.go + claude_cut_stream_test.go，字节等同），任务书预存红名单原项；单独定向跑同测试曾绿=负载敏感 flaky，预存红特征
- 无其它 `--- FAIL`（计数=1）；TestClaude* 族按字母序先于超时点全部完成且零失败
- 预存红对照其余三项（TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy）本次全包跑未触发

## 60m 全包结果（最终）

- `go test -tags nogui ./internal/gateway/ -count=1 -race -timeout 60m`：套件完整跑完 1520.183s，唯一失败=预存红 `TestBrowserKeyOffClosesItsBrowser`（同 25m 跑：race 对=测试 ↔ browser.go:421 watchKey，字节等同父提交；定向曾绿），无其它 FAIL（计数=1）
- 45m 那次后台跑被环境中止（日志 0 字节，未产出结果），以 60m 这次为准
- 45m 重跑期间发现兄弟车道（mg-5509）同机并发跑 gateway 套件——25m 首跑超时的主因即跨车道负载（60m 这次 1520s 完成可互证）

## 交付件

- head：7205d593597b7a2a80c83ab001a9338b9aab0827（amend 后；首个提交 05145df06 已被 amend 取代）
- patch：0001-claude-a-cut-short-s-failure-words-a-client-s-own-re.patch（zero-commit）
- sha256 前 16：ee10a9f123d9d10d
- 三件套自检：Attribution 精确文本 ×1、details 摘要含哈希 ×1、分支行 ×1、零中文、尾注仅在 patch 内 ×1、表区无空行
