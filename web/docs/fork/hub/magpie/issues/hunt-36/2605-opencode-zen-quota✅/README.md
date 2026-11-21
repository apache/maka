# #2605 [feat] 支持读取 OpenCode Zen（付费 API key）的额度/余额——目前完全不建卡 — 定性：推理 key 无数据源，Budgets API 是唯一半步

- issue: https://github.com/yetone/magpie/issues/2605（SurvivorLife，claim 时 0 评论）
- claim: https://github.com/yetone/magpie/issues/2605#issuecomment-6226165395
- 定性帖: https://github.com/yetone/magpie/issues/2605#issuecomment-6226175910
- 日期: 2026-10-16（hunt36-C）

## 诉求判定

报告者 Docker/web 部署，`opencode-zen` 预设加付费 key（`oc_…`，按量计费）：模型/请求都通，但 `magpie quota`、Usage 页、`/v1/magpie/quotas/cards` 完全无卡，refresh 报 `no subscription, plan or key balance of opencode-zen`（quota_cli.go:136 @upstream/main）。期望与 Go 卡同等对待；备选期望=provider 设置支持可选 console 会话。报告者愿提供脱敏 `billing/status` 样例。

## 渲染链（内置侧现状，upstream/main 6f950653 已核）

- `planQuotaSourceOf`（internal/provider/planquota.go）opencode.ai 分支只认 `/zen/go` 前缀 → 唯一端点 `https://opencode.ai/zen/go/v1/usage`（readOpenCodeGo）。`opencode-zen` 预设 base 是 `https://opencode.ai/zen/v1`（presets.go opencode-zen 块，NoKey=true），不匹配 → 无 keyed 源 → 报错不建卡。
- free 占位卡（「API key」、windows 恒空）= zen-free 插件账号面（plugin_accounts.go:36 `api`→"API key"），匿名公共通道无计量，无窗属预期。

## 数据可得性考证（2026-10-16 实测 + sst/opencode dev 树）

1. **推理通道无 usage**：`packages/console/app/src/lib/inference-proxy.ts` paths 表 zen/v1 仅 chat/completions、responses、messages、systemone、models(+google generateContent)；实测 `GET /zen/v1/usage`→404、`/zen/v1/balance`→404（对照 `/zen/go/v1/usage`→401 存在）。
2. **Console 官方 API**（opencode.ai/console/docs/api，sst/opencode `services/www/src/docs/content/console/api/*.mdx`）：推理权限 key 只能调 Inference、Providers、`GET /api/v2/config`（providers/models 配置，无花费字段）。
3. **余额接口网页会话专属**：`console/api/billing/status`（balanceMicroCents）要 `__Host-console_session`+`x-org-id`；Bearer API key 实测 401 `{"_tag":"Unauthorized"}`；该服务代码不在开源仓库（树内无 balanceMicroCents），闭源网页接口不爬。
4. **唯一 key 可达花费读端点=Budgets API**：`GET /console/api/v1/budgets/members`（实测 401 存在，官方文档）。要求服务账号 **All** 权限 key（`oc_sk_…`；文档原话 Inference-only keys cannot access budget data）；返回每成员 `limit_micro_cents`/`spent_micro_cents`/`exceeded`/`resets_at`；limit 是用户自设预算（未设=null→无窗），spent≠余额；**响应无 key→成员自识别**（按 email 排序的列表，多成员工作区归属歧义）。

## 为什么不接（patch 修不了原始场景）

- 报告者与典型 Zen 用户的 `oc_` 推理 key 对唯一候选端点（Budgets）是 403——接了也无卡，违背「修报告的症状」。
- pay-as-you-go key 无窗不建卡是既有规则：#387（MiniMax）、planquota.go CommandCode 注释原话 "a pay-as-you-go key has none, and no card"。Zen 付费 key 同类。
- #2583 同族先例（Go 卡 until 字段=上游数据不可得→定性）。

## 出路（帖中已给）

1. 上游给推理 key 开 usage/balance 端点 → `planQuotaSourceOf` opencode.ai 分支加 zen 源即可上卡（接法已探明）。
2. 用户自建服务账号 All key + 设月度预算 → Budgets 可撑「本月预算已用」Month 窗卡；若维护者认可可再做（需先考证成员行归属），但不修本单原始场景。
3. 完整余额走官方 device flow（RFC 8628，文档明说 other CLIs 可用）取 user token → 新登录面（存 token/刷新/x-org-id），属维护者决策，成本 2-3 天+GUI。

## 排雷记录

- claim 发出时 issue 0 评论、定性帖发出时仅本人 claim（REST 回读核验：6226165395 + 6226175910 均为 ggbdpq）。
- `gh pr list --search "2605 in:body"` 空；`--search "zen in:title"` open 空。
- upstream/main 6f950653 无 console-api/budgets 接线（grep internal/ 仅 claude.go 无关 budgets）；planQuotaSourceOf opencode.ai 分支与本地一致。
