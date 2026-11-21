# #2583 opencode go 也可以显示到期时间 — 定性：上游数据不可得

- issue: https://github.com/yetone/magpie/issues/2583（xiaozhu1337，0 评论）
- claim: https://github.com/yetone/magpie/issues/2583#issuecomment-6223742971
- 定性帖: https://github.com/yetone/magpie/issues/2583#issuecomment-6223759449
- 日期: 2026-10-16（hunt35-D）

## 诉求判定

截图对比：Zhipu GLM 卡标题右侧有 `Max · 11月20日到期`（套餐级订阅到期标注），OpenCode Go 卡同位置空白。诉求 = plan 级 until 行，**不是**窗口重置行（Go 卡「本月」窗的重置行已显示）。

## 渲染链（内置侧现状）

- 卡标题右侧 = `q.plan · planTerm(q)`（`internal/gui/assets/app.js:15987-15995` planSpan/planTerm，读 `q.until`/`q.renew`）
- 到期格式化：`PlanTerm`（`internal/provider/quotas.go:159`，"renews/expires/until Jan 2"）
- keyed 卡 until 注入点只有 Zhipu：`internal/provider/planquota.go:647-657`（`q.Until, q.Renew = zhipuTerm(ctx, root, j.key)` + `zhipuPersonalResets`，#1191）；`zhipuTermOf` 在 `internal/provider/zcode.go:479-517`（zhipuSubscription 的 valid/nextRenewTime/autoRenew）
- OpenCode Go keyed 卡：`planQuotaSourceOf`（`planquota.go:58-61`）唯一端点 `https://opencode.ai/zen/go/v1/usage`，`readOpenCodeGo`（`planquota.go:146-181`）解析

## 数据可得性考证（字段清单）

`GET /zen/go/v1/usage` 实测响应（magpie 记录 2026-10-10，`planquota_test.go:423-426` 注释；形状测试 `TestReadOpenCodeGo` `planquota_test.go:124`）：

```
usage.rolling.{status,percent,resetsAt}
usage.weekly.{status,percent,resetsAt}
usage.monthly.{status,percent,resetsAt}
```

- **无**订阅周期/到期字段（无 currentPeriodEnd / until / expiresAt / valid）
- 上游 `sst/opencode`：`packages/console/app/src/routes/zen/go/v1/usage.ts` 是纯代理（proxyInference → 内部 inference 服务的 `/go/v1/usage`，服务代码不在仓库）；`packages/console/app/src/lib/inference-proxy.ts` 的 paths 表里 zen/go 只有 models/usage/chat/messages/responses/systemone 六端点，无 subscription/billing
- console 网页订阅管理走网页会话认证，API key 不可达；opencode-go preset 无 Deprecated/mover（`presets.go:444`），内置卡仍是唯一呈现面

## 为什么窗口重置不算缺

`readOpenCodeGo` 三窗各带 resetsAt（`planquota.go:172-175`）；0% 窗丢弃占位 resetsAt 是全厂商统一行为（`planquota.go:143-145` 注释：0% 时厂商回 "now+窗长"，无意义）——截图 Zhipu 5 小时窗 0% 同样无重置行。monthly resetsAt 是用量回满点（rate limit 窗），不是订阅到期日，硬凑进 until 位每月都错 → 不硬凑（#1569/#1917 先例）。

## 出路（若上游补数据，接法已探明）

usage 响应若加 currentPeriodEnd 类字段：`readOpenCodeGo` 解析（需改签名或经 planQuotaSource 扩展），keyed 读取路径照 `planquota.go:647-657` 的 Zhipu 模式接 `q.Until`/`q.Renew`，卡上行即出。可建议用户去 sst/opencode 提 feature request。

## 与 #2454 协调

#2454（Command Code，`commandcode_plan.go` cmdQuotaOf）与本单不同文件不同函数；本单零代码改动，无冲突。#2454 内置侧 patch（889280a2）仍未合入，与本单互不依赖。

## 排雷记录

- issue 评论发 claim 时 0 条、发定性帖时仅本人 claim（重读核验）
- `gh pr list --search "2583 in:body"` 空；opencode in:title 的 open PR 空
- upstream/main（a69cd070）自 2026-10-14 无 opencode 额度相关自修；9fcf6a6e 的 deprecated-mover 名单不含 opencode-go
