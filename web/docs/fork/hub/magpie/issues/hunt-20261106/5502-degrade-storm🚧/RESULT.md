# #5502 车道产物：claude 降级警告 400 全路由扫号

- 单：yetone/magpie#5502（OPEN，c=0 排雷复核于 take 前；take=comment 6693580911）
- 车道：M1（hunt-20261106），upstream/main 基线 416305451
- 结论：**出列转分析帖**——缺决定性事实（降级 400 确切报文），且修法方向受 #4443 反向诉求牵制，属维护者政策裁决面；猜词匹配违背 #5346 landed 教训（"the match is the plugin's own words now"）。

## 已验证机制（全部读码核验，基线 416305451）

1. claude 订阅号失败 turn：`claude_subscription.go:2479` emit `Event{Kind: KError, Text: <CLI 文本>, Status: envelope.APIErrorStatus, Code: errKind}`。
2. `anthropic.go:1670`（case KError）把它写成 Anthropic 流的 `error` 事件，`failed["code"] = ev.Code` 保留错误码、message 保留原文。
3. walk 的 holdWriter：`fallback.go:2276`（eventError）→ `h.failure, h.failMsg = status, msg`；`streamEvent`（`fallback.go:3030`）的 errOf 把 error 事件 JSON（含 code+message）作为 msg。
4. `holdWriter.failed`（`fallback.go:2594`）= `!passing && code>=400 && retryable(code, errBody)`。
5. 400/422 分支（`fallback.go:1509`）在 `quotaWords`（`fallback.go:1235`，含 `usage.?limit|hit your .*limit|limit.?reached|limit.{0,24}resets`）命中时可重试。
6. 通用失败分支 `gateway.go:3720`：rest 该号 + continue 问下一候选 → 逐个问完 claude 路由全部账号一遍 = 报告者所见。
7. 真实文本匹配（非虚构）：`You've hit your 5-hour limit`（#4443 时间线原文）、`You've hit your Opus limit`/`You've hit your weekly limit`（官方 errors 文档措辞）均命中 `hit your .*limit`。
8. reset 识别已存在：`routing.go:244` resetsWords 解析 Claude Code 的 `usage limit reached|<unix>`。

## 出列理由（三查后仍缺）

- 缺事实：降级警告 400 的确切报文。issue 未贴、官方 errors 文档无 degraded/downgrade 条目、magpie 测试与全 git 历史无此文本、GitHub 全网无可引用原文。任何 matcher=猜词 → 会错放（压掉正常 failover）或漏放（修不动），#5346 landed review 明确重写过猜词补丁。
- 政策冲突：若"降级警告"=限额文本，则 walk 是 routing group 设计本意（#4443 要求在同类文本上**更多**切换）；若=风控降级，则报告者"非常危险"成立（同一会话按序重放全路由=批量封号模式）。两者要相反策略，裁决面在维护者。
- 可行修形已有在树模板：`claudeNoRoom`（`gateway.go:3555` + `claude_room.go:57`）——识别后同 provider 不再问、只问别家 provider、无人 rest、不重问；套上即可满足"就在当前号完成"。

## 分析帖

已发：URL 见 POST.md。三件套（Source/Not verified/AI）齐；向报告者索三事：①路由日志中一条 walk 请求的 400 原文 ②magpie 版本+账号形态（订阅/Claude Code vs API key/中转）③警告是否粘住（一出现在后续每请求都现）。

## 回滚/清理

- 无代码改动、无分支推送；worktree /private/tmp/mg-5502 与分支 fix/5502-degrade-storm 帖后自清。
