# Issue 3062 — relay 的 "Referenced reasoning item …" 拒答未被读作 unreadable item，Codex 会话每轮 400

日期：2026-10-20。工作区：`/tmp/magpie-h32`，分支 `hunt52-b-relay-refusal`，基于 upstream/main `dee5c9d7`。未推送、未发评论。

## 结论

issue 成立，且在 `dee5c9d7` 上可复核：报告者的 400 原词 `OpenCode Go: Referenced reasoning item 'rs_…' was not found or has expired.` 既不含 `unreadableItem`（`internal/gateway/codex_backend.go:1412`）现有的两个措辞分支（`encrypted content for item`、`item with id`），body 也没有 `param` 字段，所以 `refusesInput`（`codex_backend.go:1948`，passthrough 修复环的识别闸）返回 false，400 原样穿透；Codex 每轮重放全量历史，于是每轮都 400。该 matcher 上一次改动是 `67056512`（#1008 时代），`dee5c9d7` 前后无相关漂移。

修法（最小）：`unreadableItem` 正则加一个分支 `referenced reasoning item`，与既有两措辞并列、按同样的泛化方式（稳定短语 + 捕获任意 id，OpenAI 原词不动）。家族三个消费点随之全部生效：passthrough 环 `refusesInput` → `withoutBareReasoning` 剥掉无密封的 reasoning 再问一次并记 `bareReasoningRefused`（#1044 记忆）；ChatGPT backend 环 `withoutUnreadable` → `withoutItem` 按 id 精确剔除被点名的 item；压缩路径 `itemNotFound` → 摘要请求改文本再问。其余拒答（`reasoning.effort` 等）仍原样透传。

## 提交

- commit：`895240daaa5d6e703fcc0f0344e81d379afb6af9`（作者 ggbdpq <ggbdpq@gmail.com>，单提交，2 文件 +69/-10）
- patch：`0001-gateway-a-relay-s-referenced-reasoning-item-refusal-.patch`
- patch sha256 前 16：`6beb3e80c9ba5f6e`

## 证据（RED/GREEN）

1. RED（修前，现有接缝上新测试）：`TestRelayRefusedReasoningItemReadAsUnreadable`（镜像同文件 #1044 测试；stub relay 对无密封 reasoning 按报告原词逐字 400、点名请求里的 id）两个子测试（compaction、普通 turn）都失败于 400 穿透：`Relay: OpenCode Go: Referenced reasoning item 'rs_…' was not found or has expired.`——即 issue 的每轮死亡；`TestRefusesInput` 新表行同点失败（false）。
2. GREEN（修后）：两测试转绿；e2e 断言 200 + 两次请求（第二次剥掉不可解析 item、其余 item 原位保留），且下一次请求直接不再发送（`bareReasoningRefused` 记忆生效）。

## 消融与变异

- 消融（revert 产品正则、保留测试）：RED——新 e2e 与新表行失败，旧 OpenAI 措辞的表行与 #1044 e2e（param:input 路径）仍绿；恢复后 GREEN。
- 变异（把 `referenced reasoning item` 改成 `referenced reasoning itemX`）：新措辞测试红；旧 OpenAI 措辞相关测试（#1044、`TestCodexCompactItemNotFoundAsksAgainAsText`、`TestForeignReasoning*`、`TestForeignSeal*`）全绿。

## 验证矩阵（darwin/arm64，go 1.26.8）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 目标家族（10 个顶层测试：新 e2e、TestRefusesInput、TestBareReasoning*、TestCodexCompactItemNotFoundAsksAgainAsText、TestForeignReasoning*、TestForeignSeal*） | `go test ./internal/gateway/ -run 'TestRelayRefusedReasoningItemReadAsUnreadable\|TestRefusesInput\|TestBareReasoning\|TestCodexCompactItemNotFoundAsksAgainAsText\|TestForeignReasoningWords\|TestForeignReasoningIsLeftOut\|TestForeignSeal' -count=1` | ok（1.4s），exit 0 |
| 同家族 -race | 同上 + `-race` | ok（5.4s），exit 0 |
| 全包第 1 次 | `go test ./internal/gateway/ -count=1`（默认 10m timeout） | FAIL `600.370s`，超时形态（tail 无 `--- FAIL`；日志当时被误删，未能复核内容） |
| 全包第 2 次（25m timeout，空载） | `go test ./internal/gateway/ -count=1 -timeout 25m` | 548.1s，唯一失败 `TestAsyncGatewayResponseDoesNotHoldStream`（`gateway_hook_test.go:99` 固定 10s 守卫的流式 hook 测试，与本次改动无关；单跑 3/3 绿、家族复跑 2 次全绿） |
| 全包第 3 次 | 同上 | **ok（510.8s），exit 0，0 失败** |
| gofmt | `gofmt -l internal/gateway/` | 空（干净） |
| vet ×3 | `go vet ./internal/gateway/`（darwin/linux/windows） | 全 OK |
| build ×3 | `CGO_ENABLED=0 go build -tags nogui`（darwin/linux/windows，项目 release 目标同款） | 全 OK。注：不带 nogui 的全量二进制在 GOOS=linux 下挂于 wails 依赖自身（`wails/v3@v3.0.0-beta.24` 的 menu_linux.go `undefined: pointer`），属 GUI 依赖预存问题，与本次 diff 无关 |

## 不确定项

- 报告原词来自 issue 转述，本机没有真实 opencode.ai relay 可打：测试 relay 按原词逐字回放、id 取自请求（与报告 body 的形态一致）。其它 relay 措辞不同则仍需逐个收录（issue 的长期建议——记住 magpie 自铸的 id、或按 "rs_ 形 id + not found" 结构匹配——与措辞无关，明确不在本补丁内）。
- 全包第 1 次的超时未保留日志（tail 只见 `FAIL ... 600.370s` 无断言失败行）；第 2 次的 `TestAsyncGatewayResponseDoesNotHoldStream` 失败定性为负载敏感 flake（固定 10s 守卫、单跑 3/3 绿、第 3 次全包全绿），但未在 pristine `dee5c9d7` 上重跑全包对照（受"只动本 worktree"约束）。
- Windows / 交叉编译仅 build + vet，未运行测试（本仓库矩阵惯例）。

## 产物

- `RESULT.md`（本文件）
- `3062-comment.body.md`（英文，可直接发；已 grep 确认零中文）
- `0001-gateway-a-relay-s-referenced-reasoning-item-refusal-.patch`（format-patch，`git am` 可用）
