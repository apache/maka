# H8 #3517 笔记

## 基线
- upstream/main @ 40a0b442c0bdbe3d0e63d567d27249627900b150（2026-10-25 fetch，任务书预估 7b1faf99 已前进）
- worktree: /tmp/magpie-hunt80-h，分支 hunt80-h-3517
- take 评论: https://github.com/yetone/magpie/issues/3517#issuecomment-6387817654

## 定性（file:line，基线 40a0b442）
1. `internal/provider/provider.go:816` — Save 的账号分支（find(Accounts(), p.ID) 命中即插件/内置订阅供应商）用字段白名单重建 Provider，**PriceRate 不在白名单**→落盘丢失。Decide 同样不在（#3349 同病）。
2. `internal/provider/provider.go:684-699` — withPicks 把 providers.json 的 picks 合并回活账号，**不含 PriceRate**→即使落盘了也不会生效（All + AlsoOn 两个合并面都走它）。
3. 计价消费点：`internal/provider/models.go:2153-2154` EffectivePriceIn → p.PriceRate>0 时 pr.Times(rate)。p 来自 byIDOrWas→All→withPicks。
4. pluginProviderServing（plugins.go:369）构建的插件账号 Provider 不带 PriceRate→withPicks 用无条件直赋值安全（同 MaxRPM 风格；#3038 若落地插件声明价，倍率仍需适用，与 issue 原文一致）。
5. 前端（app.js:10023）编辑页两条路径（插件/自定义）都发 priceRate——前端无分叉，纯服务端丢。
6. CLI 无 provider 级 rate 键，rate 只走编辑器→provider/save。

## r3-batch（skygunner 7f927133，#3349）重叠判定
- **同 hunk 重叠**：r3-batch 在 provider.go 同一行（Save 白名单）加 `Decide: p.Decide`；withPicks 同位置加 `if pk.Decide != "" { a.Decide = pk.Decide }`。
- 字段不同（Decide vs PriceRate）→语义可叠加；**文本冲突**：同一行大字面量 + 相邻行，git am 二选一先到后到需 trivial rebase。
- 应对：本地做组合验证（r3-batch 叠加本修编译+测试），帖内写明重叠与组合顺序。

## RED 复现证据（隔离 HOME=/tmp/magpie-hunt80-h/home，magpie-bin nogui @基线 40a0b442）
- 插件 rate-repro（报告者原样插件）：POST /api/provider/save {"id":"rate-repro","models":["gpt-5"],"priceRate":0.15} → HTTP 200
  providers.json: {"id":"rate-repro","name":"","key":"","models":["gpt-5"],"pickedFrom":["gpt-5"]} —— **无 priceRate**
- 对照 ctl（自定义）：同请求体（补 chat/responses/key 表单字段）→ HTTP 200
  providers.json: ctl 条目 **priceRate: 0.15** ✓
- 计价对照：ctl/gpt-5 = $0.1875/$1.5（×0.15 生效）；rate-repro/gpt-5 = $1.25/$10（官方价，倍率未生效）
- 与 issue 报告表格逐字吻合（含 $1.25/$10 vs $0.1875/$1.5）

## TDD 记录
- 测试：internal/provider/plugin_price_rate_test.go TestPluginPriceRateSavesAndPrices（无 bun 假插件基建，沿 plugin_free_price_test.go）
- RED（基线 40a0b442，仅测试）：3 失败=bug 三面孔（providers.json 无 rate / Find 合并不带 rate / EffectivePrice 官方价）；对照组 custom 修前即绿
- 修复：provider.go 两处（Save 白名单 +MaxRPM 后加 PriceRate: p.PriceRate；withPicks MaxRPM 后加 a.PriceRate = pk.PriceRate 带 #3517 注）
- GREEN：-count=1 ok；端到端沙盒重放（magpie-bin-fixed，home2）：plugin save HTTP 200 → providers.json rate-repro priceRate:0.15（修前 ABSENT）→ GET /api/providers 编辑页见 0.15 → model price rate-repro/gpt-5 = $0.1875/$1.5（修前 $1.25/$10）
- 消融：checkout 父提交仅产品文件 → 3 失败回红（证实测试锁修复）；消融时 checkout 曾误带工作区，已重放修复并复绿
- commit：9b682735 provider: a plugin provider's price rate saves and prices (#3517)

## 组合验证（r3-batch 7f927133 叠加本修）
- cherry-pick 9b682735 → 7f927133 之上：**两处文本冲突**（withPicks 同锚点 MaxRPM 行后 + Save 白名单同一行），手工合并（Decide 条式 + PriceRate 直赋；白名单行含两字段）
- 合并后：go build -tags nogui 通过；TestPluginPriceRateSavesAndPrices ok；Decide|ReviewV2 系测试 ok
- 结论：语义正交可叠加；git am 后到者需 trivial 手工合并（同一行大字面量）

## Watched 三查
- 兄弟面（Save 白名单 vs GUI 编辑器 save 体 app.js:9382/10023 逐字段对照）：被滤的仅 priceRate（本修）；decide= 不经编辑器、走 CLI 同病 → #3349 skygunner r3-batch 已交付，本单不动；端点类（chat/responses/key）被滤是设计（账号字段归插件/agent 自有）；outputs/compacts/modelPrefs 走 SetModel* 独立通道不经白名单
- 失败读取语义：本修不触碰 providers.json 读取路径，读失败行为与修前一致
- 热路径：Save 仅编辑器保存触发；withPicks 在 All()（GUI 15s drift/dsh 30s 调用）多一次 float 赋值，可忽略

## 验证矩阵（基线+修复=9b682735）
- 定向：-run 'TestPluginPriceRateSavesAndPrices|TestPriceRateOf|TestSaveKeeps|TestProviderSaveKept' gui+provider → ok
- provider 包全量 -tags nogui -count=1 → ok 73.6s，无红无需预存对照
- gofmt -l（触达文件）→ 干净；vet -tags nogui ./internal/provider → 干净（仅预存 darwin cgo warning）
- build×3：nogui OK / default exit 0 / production exit 0

## 发布链
- push origin hunt80-h-3517 → ls-remote==local 9b68273594a961d34fecfdf89dbd3caaa038a3ab
- fetch upstream 复查：40a0b442→2009d33a（usage/google 面），零触及修复行；git am 于 2009d33a 原样适用+定向测试绿（"applies as is" 实证）
- patch sha256 前16：4aa35abb7ea61c00
- 交付帖：https://github.com/yetone/magpie/issues/3517#issuecomment-6387977825（ID 6387977825 / IC_kwDOUns_9M8AAAABfMDOYQ）
- GET 回读：bodyLen 12557 一致；唯一差异=GitHub 追加尾部 \n；patch 嵌入+sha 摘要完整
- 八项自检：分支链接1 / Attribution1 / GLM=1（仅 commit 尾注）/ 零中文 / 围栏2偶 / details 1对 / format-patch1 / 无AI use段
