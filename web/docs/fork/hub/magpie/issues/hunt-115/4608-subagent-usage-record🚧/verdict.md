# #4608 判定：Q2 降级（澄清帖），不接 patch

- issue: https://github.com/yetone/magpie/issues/4608（laoxiagenwozou-creator 报，10-31，正文一句话，0 评论）
- 帖: https://github.com/yetone/magpie/issues/4608#issuecomment-6557886981（2026-11-01T12:23:06Z，GET 回读校验过，零中文）
- 基线: upstream main `9d08993c8bd40de5d002bc364a16be344c5d78fa`
- 判定日: 2026-11-01（hunt115-D10）

## 现象

Codex 中 lead 用 sol 模型做任务、调用 luna 子 agent 时，magpie 不记录 luna 的 token 消耗。

## 机制核查（本地可判定范围内链路健全）

1. **gateway 写入层实证（探针测试，两场景 PASS）**——`probe_4608_test.go`（复用 codexSubagentSetup/codexAsks 测试基建，假 ChatGPT backend 回 usage 11/3）：
   - relay 场景（未设置 codexSubagentModel）：collab_spawn 请求带裸名 `gpt-6-luna` → relay 假 backend → usage.jsonl 得 `model=gpt-6-luna kind=collab_spawn in=11 out=3 status=200`
   - moved 场景（设置 codexSubagentModel）：`model=<设置模型> requested=gpt-6-luna` 同样在位
2. **代码读证**：
   - `internal/gateway/codex_backend.go:1506-1515`（codexUpstreamOn 成功路径 appendUsage 带 tokens）、`internal/gateway/gateway.go:4372-4388`（serve 主路径 call.To!="" 即记）——两路径写入无条件
   - `internal/budget/budget.go Append` → `internal/usage/usage.go Append` 无 kind/model 过滤
   - `internal/usage/summary_fold.go counts.add`：模型行 key=`provider/model`，所有非 rejected 记录都进
   - `internal/gateway/sniff.go`（provider.Responses 分支）：事件顶层 usage 与嵌套 response.usage 都读，无子代理特异缺口
   - `internal/gateway/codex_subagent.go:55`：`PurposeOf(kind)` 对 collab_spawn/thread_spawn/agent_job 三 kind 全映射 `kind:collab_spawn`，pick 命中无缺口
   - `internal/gateway/codex_follow.go:176`：子代理明确不被 codexFollowTo 改写（保用户 pick）
   - `internal/gateway/gateway.go:5055 fromCodex`：User-Agent/originator 前缀 codex 覆盖 Codex Desktop
3. **排雷**：open PR 零命中 4608；issue 0 评论无占坑。

## 剩余缺口（本地不可判定）→ 降级理由

- 真实 ChatGPT backend 对 sealed 子代理任务的响应是否带 usage 块：若不带，magpie 仍记行但 0 tokens，与"不记录 token 消耗"的现象同形。需要真实 ChatGPT 登录环境。
- Codex Desktop 真实请求形状（header/模型名拼写）无法本地复现。
- 另一可能：报告者设置了 codexSubagentModel，luna 消耗记在该模型名下（Usage 页 luna 行自然没有）——同样需要报告者环境确认。

## 澄清帖要的证据（四问）

1. usage.jsonl 里有无 luna 模型行（哪怕 0 tokens）→ 一刀切「记录层缺失 vs 上游零 usage」
2. Routing 页有无 collab_spawn 标注的子代理请求 → header 是否到位
3. Agents 页 codexSubagentModel 设置 → 消耗是否记在别的模型名下
4. sol/luna 是 ChatGPT 自有模型还是 relay provider 模型 + magpie 版本

## 后续

- 报告者回复证据后按答案定向：0-token 行→查真实 backend 响应形状（可能要加 sealed 任务 usage 的替代计法或接受 limitation）；无行→请求没带 x-openai-subagent，查 Codex Desktop 版本形状；行在别处→文档/FAQ 层面解释。
- 若报告者不回：gentle ping 一次后归档。
