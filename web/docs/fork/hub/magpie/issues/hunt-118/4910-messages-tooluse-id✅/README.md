# hunt-118 / d · magpie #4910 — /v1/messages reuses fc_{index} as tool_use id

- issue: https://github.com/yetone/magpie/issues/4910
- claim: https://github.com/yetone/magpie/issues/4910#issuecomment-6579299271 (take)
- branch: `fix/4910-messages-tooluse-id` (fork), base `a3768cdd1` = upstream/main tip at claim time
- commit: `4e7a832f6` `fix(gateway): salt a relayed Messages reply's tool_use id the client has seen again (#4910)`
- patch: `0001-*.patch` (git am format, applies clean on a3768cdd1; SHA-256 first 16: `3069e005403449bb`)

## 定性（与报告者症状对齐）

报告者说"magpie 把上游 tool-call id 换成 fc_{content_block_index}"。代码级核实：

- `/v1/messages` **翻译路径**（客户端 Messages、上游 Responses/Chat/Gemini）：id 来自上游 `call_id`/`tool_call id` 透传（`anthropicOutID` 对安全字符原样放行），每轮上游铸新 id → 唯一。实测两种上游形状（item id=call id、item id=fc_0+call_id 唯一）均绿，复现不了。
- `/v1/messages` **中继路径**（provider 本身说 Messages，relay as it came）：上游 Messages 桥（LiteLLM 类）自己按回复内位置铸 `fc_0`，magpie 逐字节透传 → 第二轮同 id → RED 复现，正是报告者症状（alpha→fc_0、beta→fc_0、gamma→fc_1 = 块序号）。
- 结论：fc_{index} 的铸点是**上游 Messages 桥**，magpie 的暴露面是 **Anthropic→Anthropic relay 不做跨轮唯一性保障**。修在 magpie 的 relay 面上（上游无法修，且任何按位置铸 id 的上游都触发）。

## 修法

`internal/gateway/tool_use_ids.go`（新）+ `gateway.go` passthrough 接线（3 处）：

- 请求侧（进上游前）：`clientToolUseIDs(body)` 取客户端已持有的 tool_use id 集合（含历史 assistant 块）；`saltedCallIDsBack(body)` 把上一轮加盐 id 还原为上游自己的 id（assistant `id` 与 tool_result `tool_use_id` 两个方向）→ 严格上游拿回自己的 id（#1916 家族约定），提示缓存字节稳定。
- 回复侧（relay 流内）：新 tidy `toolUseIDs`，插在 phases 与 thinkSigs 之间（含 out() 闭包、主循环、末尾 cascade 三处；!sse 整条回复走 `whole()`）。reply 的 tool_use id 若客户端已持有、或本回复已说过（轮内并行重复维度），则 `saltCallID(id, newID())` = `mp_` + base64url(id+\x00+salt) 出站——盐每次 newID()（纳秒时钟+原子序号），跨轮、跨重启、轮内均不重复；客户端只见 [A-Za-z0-9_-] 安全字符（#1304 约束保持）。
- 不碰的：客户端没有的 id 逐字节透传（健康上游零改动，有测试锁）；翻译路径（id 已唯一）；Responses/Chat relay（idTidy 既有机制不变）。

## 验证

| 检查 | 结果 |
| --- | --- |
| RED：TestMessagesRelayedToolUseIDsUniqueAcrossTurns（基线 a3768cdd1，消融回红） | FAIL：两轮同 `fc_0`（报告者症状原文） |
| 消融回红：TestMessagesRelayedToolUseIDsUniqueInATurn（并行同 id） | FAIL：`["fc_0" "fc_0"]` |
| 修复后定向 4 测（跨轮/轮内/健康上游零改动/翻译路径两形状） | 全绿 |
| whole（非流式整条回复）路径 TestMessagesRelayedWholeToolUseIDsUniqueAcrossTurns | 绿（首轮透传、次轮加盐） |
| `-race -count=3` 定向 | ok |
| `-count=5` 定向 + id 邻域（anthropic_call_ids/ids/upstream/textcalls/whole_stream/passthrough） | ok |
| `go vet -tags nogui` darwin/linux/windows | 通过 |
| `gofmt -l` 触达文件 | 空 |
| `go build` darwin / linux(nogui) / windows(nogui) | 成功（darwin ld 警告为预存 SDK 噪声） |
| gateway 全量 `go test -tags nogui -count=1`（~590s） | 首跑抓到 tidy flush 丢未完结事件尾的 bug（TestNativeStreamFailureAccounting/anthropic/unterminated 红），已修（flush 返回 out+rest）；TestCodexPoolSaysTheClientsVersion 全量下红、单跑绿、基线单跑绿——基线全量复核见 issue 帖 Run 段 |
| patch `git am` 落 a3768cdd1 | 干净（am 后 5736f24ed；末版对应 4e7a832f6） |

## Watched 三查

- id 生成点 4 处：anthropicEncoder（翻译出口，唯一，不改）、responsesEncoder.openItem（fc_+newID，不改）、textCallID（call_text_N 全局序号，不改）、relay tidy（新增，仅在碰撞时加盐）。
- id 消费/配对点：anthropicInID（翻译请求侧，不改）；relay 请求侧新增 unsalt 回程（call 与 result 双字段）。加盐 id 若流落到翻译路径（中途换供应商 fallback）会解出带 \x00 的 id——代码注释已标注该边界，罕见且上游本就不认识该 id。
- 热路径：请求侧两道 Contains 门（`"tool_use"`、`"mp_`），无工具历史零解析；回复侧每事件一次 Contains，非 tool_use 事件零解析。

## 边界（如实）

- 客户端不回传历史（不重发前轮 assistant 块）时，magpie 无法得知碰撞——Claude Code（报告者客户端）全量回传，主症状覆盖。
- 真机 Claude Code/ACP、真实 LiteLLM 聚合未实测（本机无该环境）；wire 级替身复现，症状逐字对齐。
