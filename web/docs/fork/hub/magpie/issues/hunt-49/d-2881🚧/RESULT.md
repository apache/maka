# hunt49-d-2881 — Codex 标题/描述/预测设为"自带"仍路由到其他分组

Issue: yetone/magpie#2881（侦察 lane，无日志、无路由记录，仅截图：三行设置均为「Codex 自带 (ChatGPT)」）。
分支：`hunt49-d-codex-own-route`（worktree /tmp/magpie-h23，基线 7916045591c318c84fa894022516a7ebffc9a91e）。**结论：未发现仓内可确定性复现的缺陷，走诊断评论出口，未改代码、未提交。**

## 三个设置对应什么

- `settings.CodexTitles` / `CodexDescriptions` / `CodexPredictions`（internal/settings/settings.go:435-453）。GUI 三行即截图中的「Codex 会话标题 / Codex 会话描述 / Codex 输入框预测」。
- **"Codex 自带 (ChatGPT)" = 空字符串**，语义是「照 Codex 发来的样子放行」（GUI note "as Codex sends them"，app.js:20644/20647/20671/20674）。不是「让 ChatGPT 生成」的无条件承诺。
- 路由选择逻辑：`codexTitlesTo` / `codexDescriptionsTo` / `codexPredictionsTo`（internal/gateway/codex_titles.go:30-81）：
  1. 设置非空 → 用设置的模型 id（或 "off"）；
  2. 设置为空 → 用 **Codex 自己请求里的 model**（`modelOf(body)`）——topology 1（magpie 是 Codex 的 provider，请求打到 magpie 自己的 /v1，`ours=true`）对任意模型都生效；topology 2（Codex 登录 ChatGPT 经 `/backend-api/codex` 中继，`ours=false`）仅对带 `/` 的 magpie 模型生效，Codex 自家裸模型（gpt-5.6-luna 等）**不被拦截，原样中继到 ChatGPT 登录**（codex_backend.go:106-118 → codexUpstream）。
- 拦截后的去处在 `codexTitle`/`codexDescription`/`codexPrediction` → `s.serve(..., withModel(body, to))`（codex_titles.go:108/166/210），走**与会话请求完全相同的 serve 路由**（组名/裸名经 `grouped()` 归组，gateway.go:1662-1689）。

## 假设（按优先级）

- **H1（成立，与全部代码路径自洽）**：reporter 的 Codex 会话本身就跑在 fable 分组的模型上（magpie 作为 provider，或 CodexPath 上带 `/` 的模型）。「自带」= Codex 自己把这些隐藏回合（thread_title / thread_description / composer_predictions）发在**会话模型**上（#743 测试注释明说："on the conversation's model, a magpie id"），magpie 空设置下放行到同一模型 → 路由视图记在 fable 分组下。这是设计行为：「自带」保住的是"Codex 自己选的模型"，而 Codex 选的就是会话模型；当会话模型属于某分组，这些调用自然记在该分组。ChatGPT 生成仅在 topology 2 + Codex 自家裸模型时发生（空设置不拦截、原样中继 ChatGPT 登录）。
- **H2（可排除为"总是"的原因）**：codex 订阅的 fallbacks（用户在 magpie 设置的 Codex fallback）在 ChatGPT 过载时把这些调用移交到 fable 模型（codex_backend.go:1144/1244 codexFallBack）。仅失败路径触发，路由行会带 handed-on/错误标注，与"总是"矛盾。
- **H3（可低成本排除）**：设置文件里残留早先选过的模型，GUI 显示与实际生效值不一致——API 保存后返回的就是 GUI 渲染来源（api.go:1602-1622），重启后再看三行即可排除。
- **H4（并入 H1 证据需求）**：裸模型 id 经 `grouped()`（组名/自动组匹配，group.go:761-774）被组捕获——但会话本体回合走同一条 grouped() 路径，标题与会话必然同组，不存在仓内可构造的"标题进组、会话不进组"分歧。

## 关键证据

- 关键测试把设计语义钉死：`TestCodexTitlesSetting`（codex_titles_test.go:68）——CodexPath 上空设置 → 标题原样到 ChatGPT 登录（chatgptCalls=1，magpie 模型 0 次）；`TestCodexTitleOnMagpieProvider`（:182）——magpie 作为 provider 时，空设置 → **会话模型**（fake/m1）写标题，答案被包成 {"title":…}。
- 文档一致：docs/subsystems/gateway-routing.md:46-56 "an empty setting preserves the requested model"。
- 排除"带 / 的模型被另路由"：拦截后 `withModel(body, to)` 原模型进 serve，与会话请求同一条 Resolve/grouped 路径，无第二套选路。
- 排除"key 的模型限制把它挤到别的组"：`magpieChose`（key_models.go:24-54）只豁免 key 限制，不改变目标模型；且仅当 `to == settings.CodexTitles`（用户显式选了模型）时打标，空设置下按调用方请求的模型受 key 限制——受限制是 403 拒绝，不是改路由。
- 全仓未发现任何分支：空设置 + X 配置 → 标题/描述/预测落到与会话模型不同的组。

## 结论

设置按设计工作："Codex 自带" = 照 Codex 发来的放行；Codex 在 magpie 作 provider 时把这些隐藏回合发在会话模型上，会话模型在 fable 分组 → 调用记在 fable 分组。reporter 期望的"ChatGPT 生成"在该拓扑下不存在（Codex 自己都没问 ChatGPT）。确定性缺陷：无。→ 诊断评论（`2881-comment.body.md`），索取可定案的信息：magpie 版本、Codex 接入方式（/v1 provider key 还是 CodexPath ChatGPT 登录）、会话本体回合用的模型、一条进 fable 分组的标题/预测行的 Requested model/Kind/错误与移交标注、重启后三行仍显示"自带"。

## 不确定项

- reporter 的实际拓扑与会话模型未知（issue 无日志）；若其会话确实在 ChatGPT 自家模型上而标题行仍落在 fable 分组且无移交标注，则推翻本结论，需拿路由记录重查。
- 未验证 GUI 保存链路在 reporter 版本上的行为（本机基于当前 main 分析；旧版本设置持久化是否一致未查证）。
