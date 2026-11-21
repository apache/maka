# 矩阵（hunt57-d-rest-paths，base f5b01574）

| 项 | 命令 | 结果 |
|---|---|---|
| RED 路径A | `go test ./internal/gateway/ -run TestReadingKeepsARefusalsRest -count=1`（修法完整还原） | FAIL `rest_resets_read_test.go:86: a reading that found the window less than full lifted the refusal's rest, due at 23:00:16`（red-base.txt / ablation1-red.txt） |
| RED 路径B | `go test ./internal/gateway/ -run TestAutoVisionKeepsOffARefusedAccount -count=1`（同上） | FAIL `rest_resets_read_test.go:125: AutoVision = "codex/gpt-6.1-sol", back on the refused account, before its reset`（red-base.txt / ablation1-red.txt） |
| GREEN 定向 | 同上两测试，修复态 | PASS ×2（green.txt；`ok github.com/yetone/magpie/internal/gateway`） |
| 消融1 | 还原全部源码改动（保留测试） | 双 FAIL，原文与 base 一致（ablation1-red.txt） |
| 消融2 | 保留管道，仅中和 vendorTill 闸门（`if false &&`） | 双 FAIL（ablation2-red.txt）；恢复闸门后 PASS |
| 消融1恢复 | 恢复修复态 | PASS（`ok .../internal/gateway`） |
| provider 定向 | `go test ./internal/provider/ -run 'TestStartedAgain|TestRenewedFrom|TestClaudeAccountToldRenewed|TestPluginAccountToldRenewed' -count=1` | ok |
| race 定向 | `go test -race ./internal/gateway/ ./internal/provider/ -run 'Renewed|Started|Resting|RestOf|AutoVision|SpentModel|RefusedMidRead|Allowance' -count=1` | ok gateway 10.097s / ok provider 3.214s |
| gofmt | `gofmt -l` 六个触及文件 | 空 |
| vet | `go vet ./internal/gateway/ ./internal/provider/` | 干净 exit=0 |
| build×3 | `go build ./...` ×3 | 全部 exit=0（仅预存 darwin ld 警告：objc 重复库、macOS SDK 版本号） |
| 双包全量 | `go test ./internal/gateway/ ./internal/provider/ -p 1 -timeout 30m -count=1` | 见 full-gateway-provider.log |

## 第一轮全量发现的三处回归（已解决）

| 失败 | 原文 | 定性 | 处理 |
|---|---|---|---|
| TestClaudeAccountBackOnceItsWindowRenews | `claude_renewed_test.go:100: a, its window started again: still rests by resets till …` | 维护者点名要保留的 Claude 提前重开场景；首版测试 fake 的重启读数沿用旧重置时刻+用量下跌，与新 narrowing 语义冲突 | fake 改为重启读数带新周期重置时刻（忠实于真实 /usage 形态），生产路径经 startedAgain→restarted 解除 ✓ |
| TestFactoryStandardOutLeavesCore | `factory_pool_rest_test.go:93: Opus still rests after Standard's window renewed` | 真设计缺口：首版 startedAgain 只看 whole 窗口，漏池窗口；Factory Standard 是 notModels 池、其 rest 是 by:"resets" | startedAgain 扩为全窗口（池同算）；测试的 renewed 直调补 restarted（生产双钩子语义）✓ |
| TestQuotaRestsUntilItsReset | `quota_rest_test.go:84: still resting after its windows started again` | 测试直调 renewed 模拟「花 Codex 重置」；生产路径 renewedNow 现在tell 双钩子 | 测试改调 renewed+restarted 两钩子（同生产顺序）✓ |

## 最终矩阵（最终代码复验）

- 定向五测试（A/B + 三个既有）：全 PASS
- 消融2 最终代码复验：双 FAIL 原文同 base（ablation2-final.txt），恢复后 PASS
- race 定向（含 QuotaRests/FactoryStandard/ClaudeAccountBack）：ok
- gofmt（九个触及文件）空；vet 干净；build×3 exit=0
- 双包全量第二轮：见 full-gateway-provider.log
