# hunt57 / issue #2718 最终报告（by:"resets" 休息两条失效路径）

## 产物

- 分支 `hunt57-d-rest-paths`（worktree `/tmp/magpie-h85`，base `f5b01574`），head SHA：`0f416b449ff5b6e6e6b271249ebb2148630f7cea`（作者 ggbdpq <ggbdpq@gmail.com>，已核 `git config` 来源 `~/.gitconfig`）
- patch：`docs/issues/hunt57/2718-rest-paths/0001-provider-gateway-a-rest-the-vendor-gave-the-time-of-.patch`，SHA-256 前 16：`e900fb5e291effc2`（9 files，+322/−25）
- 英文帖：`docs/issues/hunt57/2718-rest-paths/issue-body.md`（零中文已验；模型名只在 patch 内）
- 证据：`red-base.txt`、`green.txt`、`ablation1-red.txt`、`ablation2-red.txt`、`ablation2-final.txt`、`full-gateway-provider.log`、`matrix.md`、`commit-msg.txt`
- 未 push、未发任何评论/帖；主 clone 未动

## 假设与修法落点

- **①路径 A（核心）**：读数解除分级。`renewedFrom`（弱判据）照旧告诉 `renewed`，但 `renewed` 只解除非供应商点名 rest（`by:"quota"`/`by:"window"` 等，行为不变）；新增 `startedAgain`（真重开判据：上一读数满的窗口其重置时刻已过，或同窗口重置时刻换成更晚新周期；池窗口同算）经新钩子 `OnStarted`→gateway `restarted` 才解除点名 rest（`by:"resets"`/`by:"retry-after"`）。`renewedNow`（花 Codex 重置）双钩子都 tell，立即解除不变——即维护者计划第 1+2 点。落点：`internal/provider/allowance_renewed.go`、`internal/provider/routing.go`、`internal/gateway/routing.go`、`internal/provider/key_allowance.go`（key 读数 keep 返回双词，对称处理）。
- **②路径 B（与简报不同）**：核实后识图选型**已看休息**——`spentModel` 把 failQuota/failCredit 休息算 spent、`autoSpent` 会拒绝发描述请求（#1801 加的）。B 的 21 次是 A 的下游：读数清了 rest → 模型不再 spent → 又被选中。B 无独立代码修；B 的 RED 测试 = A 场景 + `AutoVision` 断言（rest 在、弱读数过后仍避开休息账号）。与维护者评论的定性一致。
- **③**：一个 commit（B 由 A 覆盖，无第二处代码），两个测试独立成文、分别消融。

## RED / GREEN 原文

- 路径 A（base）：`rest_resets_read_test.go:86: a reading that found the window less than full lifted the refusal's rest, due at 23:00:16`
- 路径 B（base）：`rest_resets_read_test.go:125: AutoVision = "codex/gpt-6.1-sol", back on the refused account, before its reset`
- 修复后：两测试 PASS；provider `TestStartedAgain`（新表驱动）PASS。

## 消融

- 消融 1（完整还原修法、保留测试）：双 FAIL，原文与 base 一致（ablation1-red.txt）→ 恢复后 PASS。
- 消融 2（保留管道、仅中和 vendorTill 闸门）：双 FAIL（ablation2-red.txt；最终代码复验 ablation2-final.txt 同文）→ 恢复后 PASS。

## Watched 三查

**(a)** 已述。

**(b) 解除/重读全路径（逐个定性）**：
1. gateway `renewed`（读数弱解除：Allowances diff + key keep 两漏斗）→ **改**：跳过点名 rest；
2. gateway `restarted` → **新增**（真重开/重置花掉才解除点名 rest）；
3. `renewedNow`（`codex_resets.go:234` useCodexReset）→ **改**（双钩子；对外行为不变：立即解除全部）；
4. key 读数 `readKeyAllowance`/`noteKeyAllowance` → **改**（keep 返回双词、双 tell）；
5. `narrowWhenRead`（account→model 重键，非删除语义）→ 不改；
6. `Unrest`/`UnrestAll`（手动解除）→ 不改；
7. 候选答对后自清（routing.go:138/148 clearRest）→ 不改；
8. `restAfterMarked` 同键覆盖写 → 不改；
9. `staleAllowance`/`staleKeyAllowance`（强制重读）→ 不改（只作废缓存，解除裁定在钩子）；
10. `restOf`/`restingOf` 到期判断 → 不改。

**rest 类型清单**（By 值）：`credit`、`retry-after`、`resets`、`window`、`quota`、`cooldown`、`backoff`、`restricted`、`verify`、`off`。受影响仅 `resets`、`retry-after`（均 Why=failQuota、供应商点名）；`quota`/`window` 弱解除照旧；`credit`/rate/cooldown/backoff/restricted/verify/off 本就不被 renewed 碰——零变化。

**识图外旁路选型**：`autoVision`、searcher 的 `smallReady`/`smallModel`（search.go:476/465/611）、组内 `spentAfter`、`restLast`/weigh 排序——全部经 `spentModel`/`restOf` 看休息，未发现不看 rest 的选型旁路。

**(c) 负例守卫**：`TestQuotaRestsUntilItsReset`（重置花掉解除、rate/backoff 不解除）、`TestClaudeAccountBackOnceItsWindowRenews`（Claude 提前重开仍解除——维护者点名保留的场景，测试 fake 改为重启读数带新周期重置时刻，忠实真实 /usage）、`TestFactoryStandardOutLeavesCore`（#1979 池窗口重开解除 by:"resets" 池 rest）、`TestPluginAccountToldRenewed`/`TestClaudeAccountToldRenewed`（非点名 rest 弱解除不变）、`TestRefusedMidReadRestsByWindow`——全绿。

## 矩阵（逐项）

定向双测试 PASS；provider 定向（Renewed 家族+新表）PASS；race 定向（Renewed|Started|Resting|RestOf|AutoVision|SpentModel|RefusedMidRead|Allowance|QuotaRests|FactoryStandard|ClaudeAccountBack）双包 ok；gofmt 九文件空；vet 双包干净；build×3 exit=0（仅预存 darwin ld 警告）；双包全量 `-p 1 -timeout 30m`：**gateway 327.956s ok / provider 73.621s ok**（full-gateway-provider.log）。

## 第一轮全量抓到并已解决的三处回归

1. `TestClaudeAccountBackOnceItsWindowRenews`：Claude 提前重开场景；fake 重启读数原沿用旧重置时刻+用量下跌（与 #2718 矛盾形态同形），改为新周期重置时刻。
2. `TestFactoryStandardOutLeavesCore`：暴露真设计缺口——首版 `startedAgain` 只看 whole 窗口，漏池窗口（Factory Standard 是 notModels 池，其 rest 是 by:"resets"）；扩为全窗口，测试直调 renewed 处补 restarted（生产双钩子语义）。
3. `TestQuotaRestsUntilItsReset`：测试直调 `renewed` 模拟花重置；改为双钩子调用（同 renewedNow 生产顺序）。

## 不确定项

- 报告者场景里真实 usage 读数数值不可知（其自述也是推断；Usage 页全程显示满）——修法按维护者裁定「点名 until 更权威」落地。
- 维护者计划第 3 点（读数不可信闩锁）与第 4 点（解除写 routing 日志）**未做**，issue-body 的 Not verified 已如实声明；narrowing 本身已消除 11/21 次重试。
- `startedAgain` 真而 `renewedFrom` 假的罕见分叉（某池窗口重开而整体视界变晚）会经 restarted 解除点名 rest——比 base 宽的一格，可接受并已记录。
- 三个既有测试被改动（quota_rest/factory_pool_rest/claude_renewed）：均为直调内部钩子或读数形态跟不上新契约的适配，被测行为全部保留。
