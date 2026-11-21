# #4584 让位分析（hunt-115-a7，2026-11-01）

**判定：让位（故障组件已由维护者自修并关单）+ 分析帖。无 core patch、无分支、未 take。**

- 帖：https://github.com/yetone/magpie/issues/4584#issuecomment-6557639485（ggbdpq，2026-11-01T12:00:30Z，body 4406 字符，GET 回读核对）
- 开工 SHA：upstream/main `9d08993c8bd40de5d002bc364a16be344c5d78fa`（主 clone 只读，未建 worktree）

## 根因链（全部核实）

1. `@magpie-community/opencode-workbuddy-auth` **0.2.7** 对 China build（copilot.tencent.com）的 deepseek-v4.1-flash 上报 100000 钳制——来源 [plugins#561](https://github.com/magpie-community/plugins/issues/561)（10-31 18:57 提出：>100k 即 400 "prompt is too long"；yetone 依一条未能自验的错误文本落钳制）
2. 10-31 同晚三用户实测推翻（110k–992k 全 200、needle 全召回）→ yetone："You're right, the cap was wrong" → **0.2.8（42a5055）移除钳制**，恢复 config 的 1M；magpie v0.1.2411 自动升插件；#561 11-01 关单
3. 报告者时间线吻合：20:42 掉 100K = 插件自动升 0.2.7；22:52:06 升 0.2.8 = 恢复 1M/128k（恰为其供应商设置）；10-26 写出 1M 因当时钳制尚不存在（0.2.6 时代）
4. `maxTokens: 100000` 为 `OutputWithin(window, output)` 下游效应

## core 行为 = 设计而非缺陷

- `Provider.WindowOf`（internal/provider/models.go:3188）：按模型 `Contexts[m.ID]` 无钳制直接生效 > 供应商级 `Contexts["*"]` 被 `max(catalog.Window(m.Context), m.MaxContext)` 钳制（**#2112**，`273ab9c23`，2026-10-14 发布，防超问 400）> `ListedWindow`（vendor 列表 > models.dev，后者永不钳用户设置）
- 报告者 10-26 能写出 1M 恰证明钳制早已在而厂商词当时是 1M——归因锁死在插件数据，不在 core
- DSH 路由 60s 重写（dsh.go `dshPiModel`）从生效值回写，属设计，故只能修源头

## 让位信号（三重）

1. 故障组件（插件）维护者已自修关单（= "上游已自修必查"命中）
2. GUI 逐模型窗口输入+来源显示（`Auto (1M)`/`Provider (272K)`）维护者在 #2326/#3014 已确认排期（= 方案先行）
3. 抬高语义改供应商级会逆转 #2112 设计，非本车道可擅自裁决

## 报告者 Q&A（帖内已答）

- Q1 100000 来源：插件 0.2.7 自报钳制（非 models.dev/别名回退/未知默认）
- Q2 覆盖为何不生效：#2112 钳制语义（min），0.2.8 后自动恢复；每模型覆盖（`magpie model spec <p/m> --context`）可越过厂商词
- Q3 `:1017` 语法：`model-id=值` 内联即可，后缀仅当列出的 id 本身带后缀（#2326 yetone 确认）
- 补充问：供应商级取 min 属设计；20:42 变化是 0.2.7 到达，非厂商拉新或别名重解析

## 兄弟面（rg 全查，不改理由）

`WindowOf` 消费方：catalog entryFor（/v1/models、agent config、路由）、GUI providers/app/lightweight、gateway/fallback、sessions 记录（call_revisions 存请求时窗口）——全部读同一生效值，无独立缺陷面。#4278 session 计价路径不触窗口。压缩阈值族（85fcac4a4）与 grok 手设窗口族（a0ba8e1f2）不受影响。

## 排雷

无 open PR/认领；唯一 cross-ref 为 11-01 github-actions[bot] 生态监控 issue #52（magpie ecosystem monitor），非认领。c=6 逐条读毕，无维护者表态，qq81403717-code "0.2.8 已修复"与 #561 吻合。
