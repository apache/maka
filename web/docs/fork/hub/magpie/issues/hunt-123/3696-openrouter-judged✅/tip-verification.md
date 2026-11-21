# #3696 已 landed 判定 — tip 核对记录

- 日期：2026-11-04
- worktree：/private/tmp/mg123-e（分支 fix/3696-openrouter-judged，快进到 upstream/main tip）
- tip SHA：**e17b6cefc**（"provider: the Qoder movers install opencode-qoder-auth 0.2.61"）
- 判定车道：维护者已修，发判定帖，不发 patch

## 时间线（据评论）

| 时间 | 事件 |
| --- | --- |
| 2026-10-26 | magicseek 报单：magpie 0.1.1285，代码在 v0.1.1476 / v0.1.1564 相同；A=DeepSeek 工具轮 thinking 块无 signature 被 OpenRouter 拒；B=mid-conversation system 消息带 per-message output_config 被拒（DeepSeek 与 GLM） |
| 2026-10-26 | yinwu01（JoeyWu-tech）：A 同 #2883，给出 fork patch d9283c78（aBlock.MarshalJSON 补写 `"signature": ""`） |
| 2026-10-27 | yetone（维护者）：已修，随 **v0.1.1710** 发布（**commit 5f3146be0**）；A 收 JoeyWu-tech 补丁（保留作者署名，提交 Author 即 JoeyWu-tech），B 合入时补上；遗留一项：system 消息不带 output_config 时 DeepSeek 的通用 400 未处理（请报告者复现时贴完整 body） |
| 2026-10-27 | magicseek：**v0.1.1734** 真实 OpenRouter 实测确认 B 面（z-ai/glm-5.3-flash，首次请求即 200，per-message output_config 不再发送）；A 未明确实测确认 |

## 面核对（tip = e17b6cefc）

### A 面：unsigned thinking 块补签名

- 修复提交 5f3146be0（v0.1.1710），Author: JoeyWu-tech — 与维护者评论「保留其作者署名」一致。
- tip 现状：`internal/gateway/anthropic.go:66-73` — `aBlock.MarshalJSON` 对 thinking 块无条件写 `"signature"`（无签名时为空串），覆盖 withThinkingOnToolTurns 的工具轮补位块与按文本回放的 reasoning；有签名块照旧。
- 守卫测试：`internal/gateway/deepseek_anthropic_thinking_test.go:192` `TestOpenRouterDeepSeekThinkingHasASignature`。
- 报告者确认状态：未在真实 OpenRouter 上明确确认 A（B 的实测确认单里未提 A）；A 的验证依据=假上游测试红转绿 + 提交信息里 2026-10-19 对 api.deepseek.com/anthropic 的手动实测（空签名 200）。

### B 面：per-message output_config 被拒后摘除重问

- 同一提交 5f3146be0，合入时补上（维护者评论）。
- tip 现状：
  - `internal/gateway/anthropic_shapes.go:81` — `turnEffortRefused` 正则扩展为同时匹配 `messages.N.output_config: Extra inputs are not permitted` 与 OpenRouter 措辞 `Mid-conversation reasoning effort (configuration_update) is not supported`。
  - `internal/gateway/anthropic_shapes.go:109-111` — 命中且 body 确有 per-message output_config（`hasTurnEffort`，:189）时按 provider 记 `shapeTurnEffort` 不可用（`mark`，:99）。
  - `internal/gateway/anthropic_shapes.go:160-162` — `withoutRefusedShapes` 对该 provider 走 `withoutTurnEffort`（:205）：只摘 messages 逐条的 `output_config`，请求顶层 `output_config` 与 system 消息文本保留（函数注释与实现一致）。
- 守卫测试：`internal/gateway/deepseek_anthropic_thinking_test.go:309` `TestOpenRouterTurnEffortLeftOut`（deepseek-v4.1-flash-1017 与 z-ai/glm-5.3-flash 两个子测试）。
- 报告者确认状态：**已确认** — v0.1.1734 真实 OpenRouter，z-ai/glm-5.3-flash，首次请求 200。

## 版本对照

- 报告者版本：**0.1.1285**（GUI；代码在 v0.1.1476 / v0.1.1564 相同）→ 全部早于修复。
- 修复首发：**v0.1.1710**（5f3146be0）。
- 报告者实测确认版本：v0.1.1734。
- 最新：release **v0.1.2889**，tag **v0.1.2891**（2026-11-04 `gh api repos/yetone/magpie/releases` / `tags`）。

## 鲜度检查

- 2026-11-04 fetch upstream main：247794c61 → e17b6cefc（仅 Qoder provider 一单），无 #3696 新动作。
- `git log upstream/main --oneline --grep=3696` 命中两条：5f3146be0 本尊；32ea16c5a（#3766，AgentRouter 单，正文只是提到「#3696's sentences merged」的措辞沿用，与本单无关）。

## 遗留（如实入帖）

- 维护者明言未处理：mid-conversation system 消息**不带** output_config 时 DeepSeek 回通用 `400 Invalid Anthropic Messages API request`（报告者脚注称是 A/B 叠加态）；OpenRouter 该 400 不指名字段，无法据此学习；等报告者升级后若复现贴完整 body（metadata.raw path）。

## 判定

**已 landed**（v0.1.1710，5f3146be0，双面都在 tip）。报告者版本 0.1.1285 旧于修复发布 → 判定帖给版本对照 + 升级指引（≥ v0.1.1710，最新 v0.1.2889）。不发 patch。
