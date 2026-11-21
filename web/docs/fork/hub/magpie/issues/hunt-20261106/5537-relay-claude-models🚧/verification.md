# #5537 验证记录

head：2b490c28d171e7cc398b7b7db17c707628ef9939（基线 416305451 = upstream/main）
patch sha256 前 16：b8418292502bce40

## RED（修复前，精确输出）

```
--- FAIL: TestClaudeCompactWindowRelayClaude (0.16s)
    claude_compact_test.go:351: a relay's claude model: ""; want "272000"
```

## GREEN（修复后）

- TestClaudeCompactWindowRelayClaude：ok
- TestClaudeCompact|TestPickerModelsTheirOwnWindow|TestClaudeGroupCompactWindow 定向组：ok
- internal/agent 全包：ok（预存红 TestMothX、TestWSLProbeLooksPastWindowsCommand，两者在基线 416305451 同样失败，已用 stash 对照核实）
- internal/provider 定向 TestCompact|TestClaude：ok 21.1s
- internal/gateway 全包 `-tags nogui -timeout 25m`：ok 806.1s；`-tags nogui -race -timeout 25m`：本机 25m 超时（无 race 全包已 806s），race 覆盖改走改动包定向（agent compact 组 ok 35.1s）

## 消融

- `git checkout HEAD~1 -- internal/agent/claude.go`（只回退产品文件，测试保留）→ TestClaudeCompactWindowRelayClaude FAIL（`a relay's claude model: ""; want "272000"`）
- `git checkout HEAD -- internal/agent/claude.go` 恢复 → ok

## 矩阵

- gofmt -l internal/：clean
- go vet（darwin）agent/provider/gateway：clean
- go vet GOOS=linux agent/provider：clean
- go build ./...（darwin）：ok（仅 ld duplicate libraries 警告）
- go build . ./internal/... GOOS=linux：internal 全绿；root main 在 wails/v3@v3.0.0-beta.24 自身 menu_linux.go `undefined: pointer` 失败 = 任务书预存对照项「linux wails」，依赖内部问题与 diff 无关

## 旧假设测试的期望翻转（本单语义）

- TestClaudeCompactWindow：claude 腿改用官方 provider（an），v（中转）claude 腿期望翻转 272000
- TestClaudeCompactAt：none-set 腿 →「every model's 400000」（CompactAt 用户阈值现也适用于中转 claude，正确语义）
- TestClaudeCompactWindowBedrockClaude：br 改真 Bedrock（Preset: "bedrock" + bedrock-runtime host），断言不变（官方服务不写）
- TestPickerModelsTheirOwnWindow：desktopPlan 下中转 claude main 的 272000 从 per-model 条目变为 top-level autoCompactWindow（claudePlan 既有收敛设计，压缩值不变）
