# hunt-122 / Lane E / #5043 工作日志（2026-11-03）

结局：**让位闸（已 landed）→ 出列 + 英文分析帖，未 take，未出 patch**。
帖：https://github.com/yetone/magpie/issues/5043#issuecomment-6608486952（GET 回读过：3511B，表/判定/Not verified/AI use 齐）
帖稿：post.md（本目录）。

## 判定链（全部静态验证于 /private/tmp/mg122-e @ 1e1068c86）

1. 修复已存在：40a287b21（yetone，2026-11-03 17:23 +0800）"gateway: a quiet Claude Code run begins the reply and pings its client (#5043)"，首个 tag v0.1.2838（当前 tip 已到 v0.1.2862）。commit message 逐字引用报告者数字（599.29/599.33、385/527）并附真实 claude 2.1.316 复现（598.38s watchdog）。报告者版本 0.1.2738 早于修复（merge-base 验证）。
2. 599s 取消 = 外层 Claude Code 2.1.316 自身 watchdog：修前 held stream 200+comments 止于 keepaliveLongest=5min（gateway.go:8294），byte watchdog 300s 后收线=599s。499 文案=客户端 context 取消（side_deadline.go:72），非 magpie 自身上限（那会是 "magpie stopped waiting"）。
3. 取消→内层 CLI 结束：letGo（claude_subscription.go:2780）`!r.tui` 必 abortFor；shim（claudetui/tui.go:620）只认 initialize control_request，rewind_conversation 被显式拒绝——tui 不可回退是设计。
4. 重试→replaySession（claude_replay.go）：全新 sid 两行 transcript，整段历史=单条 user 消息 → 线上前缀从未被缓存 → cache_write=221350/cache_read=21280（21k=Claude Code 自身 system+tools 稳定前缀）。#3808 的 pastUnanswered 修法仍未落上游（grep 无）。
5. 首包 385-527s = ~242k 未缓存前缀 prefill；修复后 keepBridgeHeard（claude_subscription.go:6256）：bridgeHeardAfter=1min 起 KStart，holdLead=holdThinking=4min（fallback.go:2583/2590）出 message_start，预算 599s→~14min，覆盖报告者观测。
6. vision.go 的 10min 是"盲模型配图描述"路径，opus-5-5 原生看图不适用，排除。
7. 同路由 38s 短请求 = 路由/代理健康，延迟来自 replay prefill。

## 留给维护者的两点（帖内已写）
- 仍发生的取消（手动停、首包 >~14min）依旧整段重写缓存——#3808 prefix mismatch 是后续杠杆。
- >14min 仍是 Claude Code 2.1.316 自身 600s 界限。
