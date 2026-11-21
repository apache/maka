# Discord 推荐清单台账（六轮催办全记录）

> **分卷（2026-11-07）**：原文件 55 KB，按 `##` 节边界逐字分为两卷，行文未改。本文件为卷01：总账、第一至第十三轮、当前真在途、出局/不推记录；[卷02](Discord推荐清单台账-卷02.md)：第十五轮起（含第十六、十七轮与 11-05 起各批次）。新轮次追加到卷02末尾；结局变化在该行所在卷改。

> 建立：2026-10-31。用途：每轮 Discord 整批推荐帖的单子、落地提交与最新状态一表可查。
> 维护惯例：新轮次**追加新节**；单子结局变化只更新该行「最新状态」列并改行尾核验日期，不删历史行。
> 方法论与话术判例：[handbook/02-维护轮任务书「Discord 推荐清单」节](../../handbook/02-维护轮任务书.md)；避坑条 20-22（对账双层查/测试校验被测对象/环境类 Not verified 天花板）。

## 总账（截至 2026-10-31 深夜，第六轮发帖前）

- **6 轮 57 单次**：前五轮 44 单次（38 进 main、2 支上游另路/自修 #4261/#3020、1 declines #2829）+ **第五波 4 单 v0.1.2399 全 author 署名落地**（维护者 issue 侧已发 Landed 帖，#4495 报告人 itspig 13:36 已确认 Works 待关）+ **rework 在办 #4502 被上游真机自修吸收**（73a12e8bf v0.1.2403，Discord 帖致谢 finding the link，我方 rework 分支作废）。**真在途 3 支**（#1448/#2471 扩面/#2198）+ #3373 patch 撤回留档（维护者给新修法方向留开）。第六轮 13 单见下节。
- 奏效公式：刚追平 + 整批帖；每轮奏效率见各节。

---

- **11-01 晨核验（第七轮前）**：第六轮 13 单**一夜收 10**（#4571/#4572/#4575/#4561/#4562/#4563/#4529/#4511/#4530/#4278——其中 #4572/#4575/#4278 主题行无单号靠关键词层核出；#4561/#4562/#4561 三支「(#N review)」形态 author=yetone 无 trailer=零署名族新形态）+ #4547 报告者确认误报（可关）；未收 3 支（#4574/#4436/#4063）+#2855（非推荐单，重排车道）已于 11-01 晨派 4 车道重排到最新 tip。六轮累计进 main：38+4+1(#4502)+10=**53 支**。

- **11-01 深夜终核（发帖后 ~1h）**：r7 **20/20 整批收编，零拒绝**——14 支含 author=ggbdpq 直提（7 支另有维护者追补笔，追补主题带报告人 credit：wjq990112/Azir-11/Edward4226），3 支维护者另案重写（#3484/#3153/#2969，我方支留档），#3881 issue 已关。六轮+七轮累计进 main：53+20=**73 支**。奏效率 100%（对 r6 的 77%——拒绝全部发生在方向错误单，方向对的批帖零拒）。

- **11-01 r8 回核（发帖当日，维护者整批逐支亲审后 v0.1.2520 一波收编）**：r8 十单 **9 收 1 剔**——9 支全落 v0.1.2520（02:22-02:30 UTC，author=ggbdpq 全保留、as written；3 支带维护者 review 追补：#2833 `15ffd3b68`、#3052 `73528a9a0`、#3852 `9be72c948`）；#4106 审后剔除（sha256 对上但「its test isn't red without the fix」不收，见出局区）。同屏老单三支核实无新问题：#4529 报告人 sd362318 于 v0.1.2522 确认后已关、#4512 报告人 CNife 确认后已关、#3260 维护者追 `0cabaaf24`（v0.1.2532，#4151 Mac portable 同域扩面）仍 open 等报告人。八轮累计进 main：73+9=**82 支**；r8 奏效率 90%（唯一剔除是测试证据不足，非方向错误）。

## 第一轮（2026-10-27，12 单，首轮力推帖）

| issue | 结局 | 落地提交 | 最新状态（10-31 核验） |
|---|---|---|---|
| #2837 | ✅ 已合 | `95ef45fda`（v0.1.1287）| closed（真机 1.19.0→1.19.4 确认后关）|
| #2791 | ✅ 已合 | `b10f43e89`（v0.1.1759，适配改记内部标记）| closed |
| #2725 | ✅ 已合 | `fff05e55d`（v0.1.1754，plannedCarrier 只读不加权）| closed |
| #2167 | ✅ 已合 | `84ef22dd3`（v0.1.1761，sunkAt 先查 restID+unsinkAll）| closed |
| #2481 | ✅ 已合 | `7f0f71a0e`（v0.1.1762，routeOf(tr) 封 nil panic）| closed |
| #2454 | ✅ 已合 | `ff7048dec`（v0.1.1766，作者保留+周期末守卫）| closed |
| #2405 | ✅ 已合 | `eaa71168a`（v0.1.1768，作者保留 15 行映射）| closed |
| #2488 | ✅ 已合 | `85b45b4d7`（v0.1.1765，one() 助手走 Served 同链）| closed |
| #2199 | ✅ 已合 | `c2d6a64c7`+`a42d90d7d`（v0.1.1769，+维护者 200 id testdata）| closed |
| #2197 | ✅ 已合 | `c2e3a057e`（v0.1.1770，toldAside 共用豁免）| closed |
| #2198 | ✅ 已合→↺ reopen | `90258cf20`（v0.1.1763）| **open**：维护者条件「有真实 WSL 环境的人确认后再关」，我方越权关单已 reopen 留言 |
| #2829 | ✗ declines | —（try-box 提案，正文即交付）| open 留档：#1354 后不加新 UI 的界线，分支 `ggbdpq-try-rule` 留 fork，非 UI 形态将来另开 |

## 第二轮（2026-10-30，7 单）

| issue | 结局 | 落地提交 | 最新状态（10-31 核验） |
|---|---|---|---|
| #3739 | ✅ 已合 | `72e8d9fa6`（v0.1.2216）| open（output_config.effort 丢 thinking 的第二问题维护者明说未处理）|
| #3835 | ✅ 已合 | `e31ccf230`（v0.1.2224，保分类器缓存标记+旧块边界）| closed |
| #3985 | ✅ 已合 | `fa427216a`（v0.1.2216，保原作者）| closed |
| #4265 | ✅ 已合 | `2e088a591`（v0.1.2217，吸收重做：弃我方 130 行复制改 proc.RealPath，正文署名）| closed |
| #2937 | ✅ 已合 | `84a0330f0`（v0.1.2224，${subagentId} 沿我方方向收窄 header 面）| open |
| #2532 | ✅ 已合 | `024393fbb`（wrke1990 修复维护者保作者 cherry-pick；我方验证背书）| open |
| #4256 | ✅ 已合（r3）| `dd279e931`+`0fcb3acb3`（v0.1.2257；r2 曾被 "Not landing as it is"，按维护者 spec 重做）| open 等 Jirry 真机确认 |

## 第三轮（2026-10-31 凌晨帖，8 单 = 7 推 + #4261 收尾确认）

| issue | 结局 | 落地提交 | 最新状态（10-31 核验） |
|---|---|---|---|
| #4256 r3 | ✅ 已合 | 同上（升帖首位）| open 等 Jirry |
| #2954 | ✅ 已合 | `a5ccf3f23` | open |
| #2879 | ✅ 已合 | `50816ce02` | open |
| #4065 | ✅ 已合 | `7da972969`（放宽新测试时间余量）| open |
| #3994 | ✅ 已合 | `460687ff5`（补「下一轮不带被拒推理」断言）| open |
| #3978 | ✅ 已合 | `d965a239f` | open |
| #2471 | ✅ 已合（第一形态）| `86fef947e`（维护者拍板：finish_reason "error" 全厂商按失败）| open（维护者留开两形态→第五波扩面）|
| #1448 | ⏳ review 中 | — | **open 在途**：无真实 Cline 抓包不改全 Responses 客户端工具名；我方机制证据帖 6534895317（独立插件 nameGuard 同型比对），接受 scope 收窄 |
| #4261 | ↺ 上游另路 | `cae785a3`（不引用单号）| open 待关（确认帖 6527501797/6534543946）|

## 第四轮（2026-10-31，A6+B5 = 11 单）

| issue | 结局 | 落地提交 | 最新状态（10-31 核验） |
|---|---|---|---|
| #3152 | ✅ 已合 | `c272e5582`（泛化胜出：any model's 8.0）| open |
| #3747 | ✅ 已合 | `a808c31a7`（as written）| open |
| #3039 | ✅ 已合 | `2c5d9101b` | open |
| #2580 | ✅ 已合 | `df1c3dace`（中流行持有到 error 事件）| closed |
| #1475 | ✅ 已合 | `82ff88933` | open |
| #3740 | ✅ 已合 | `7fe191cec`（裸 400→502 rests nobody）| open |
| #3264 | ✅ 已合 | `23a5e822d` | open |
| #3269 | ✅ 已合（半边）| `6f435677c`（另一半→#3260 第五波补）；**11-01 重排→`1536015f6`**（[refresh 帖 6548929938](https://github.com/yetone/magpie/issues/3269#issuecomment-6548929938)） | open | ✅ `2c33db249`（ggbdpq，主题无单号） | 11-01 深夜核验 |
| #3351 | ✅ 已合 | `bdc1617be`（计整天不按保留条数）| open |
| #3020 | ↺ 上游自修 | —（我方批测漏查）| closed |
| #3373 | ⏳ 未落 | — | 结局见第五波行：维护者 review not porting，我方认四点撤回，patch 留档不再推 |

## 第五波（2026-10-31 深夜帖，6 支 = 5 新 + #3373；#4553 已收编出局、#4502 驳回出局；**后续核验：4 单 v0.1.2399 落地全保 ggbdpq 署名，#3373 patch 撤回**）

| issue | 结局 | 落地提交 | 最新状态（10-31 深夜核验） |
|---|---|---|---|
| #4548 | ✅ 已合 | `2672ba429`（我方，author=ggbdpq）+`c63c2136b`（维护者补 gap，author=yetone）| open（维护者 12:55 issue 发 Landed 帖，等报告人确认）|
| #4495 | ✅ 已合 | `7804dfbb0`（**主题行无 (#N)**，author=ggbdpq）| open→**报告人 itspig 13:36 已确认 Works on v0.1.2399，待关** |
| #3260 | ✅ 已合 | `509d8e7d1`（**主题行无 (#N)**，author=ggbdpq，正文点名 YOUIMARK）| open（维护者 12:55 Landed 帖，等报告人确认）|
| #4512 | ✅ 已合 | `6585315e3`（3 次干净回答后 reasoning 放行——深夜复核时新发现）| open（维护者 12:55 Landed 帖，等报告人确认）|
| #2471 扩面 | ⏳ 未落 | — | **open 在途**：两形态（空 response.completed / 无 finish_reason 的 Chat 流）同样按失败 failover，分支 `5cdd5c1f8` 已与上游 #2086 句合流（rebase 帖 6542787823，19:28 发出等回合）；**21:4x 批测复验：am 落 ccc791231 干净+定向绿** |
| #3373 | ↺ patch 撤回留档 | — | **形态反转**：维护者 review 明说 not porting（bare id 不进 `b.calls`，run 后台空转+client result 找不到 run+全量重述 cache write），我方认四点（02:29 帖，branch as record only）；维护者留开报告给新修法方向（hand over+end run 同步，权衡 re-tell 成本），我方 offer 验证协助——**无 patch 不再推** |

## 第六轮（2026-10-31 深夜帖，13 单 = 8 第三方用户报 + 5 维护者亲单；批测基线追 upstream 至 63cb1af3c）

> 报告人核验（发帖前定稿补做）：第三方 8=#4571 zelong77/#4574 rookie-ricardo/#4575 AAEE86/#4572 yhong91/#4529 sd362318/#4530 hheei/#4436 ktKongTong/#4278 parkavenue9639；维护者亲单 5=#4561/#4562/#4563/#4511/#4063（帖内分组表述「你自己开的几单我们也接了」，不说「用户报的」；#4511 过避坑条 16 三征 0/3=非自留族）。

| issue | 候选分支 head | 批测（am + 定向测试） | 最新状态（10-31 深夜） |
|---|---|---|---|
| #4571 | `83cde3cf`（hunt111-a-nonstream-cache）| CLEAN + TestPluginWholeAsked* 绿 | 待收 | ✅ 收编 `39e8ced8f`（author=yetone 无 trailer 零署名族） | 11-01 核验 |
| #4574 | `fcafc082`（hunt112-b-desktop-context）| CLEAN + TestClaudeDesktopBudgetUnmarked 绿 | 待收 | ⏳ rebase 车道在办（11-01 晨，基线前移后重排） | 11-01 |
| #4575 | `32a91976`（hunt112-a-opencode-order）| CLEAN + TestOpenCodeModelsInOrder 绿 | 待收 | ✅ 收编 `cdd470ce9`（author=ggbdpq，主题无单号） | 11-01 核验 |
| #4572 | `f74a5107`（hunt111-c-routing-skill）| CLEAN + TestRepoWithARoutingSkillListsItsSkillsToo 绿 | 待收 | ✅ 收编 `b0361f785`（author=ggbdpq，主题无单号） | 11-01 核验 |
| #4562 | `fff5d643`（hunt108-h-text-tool-call-websearch）| CLEAN + TestTextWrittenCallSearchRouted 绿 | 待收 | ✅ 收编 `c8df9ecbb`（(#4562 review)，author=yetone 零署名族） | 11-01 核验 |
| #4561 | `ab39ddcb`（hunt108-g-plain-schema-ref）| CLEAN + TestPlainSchemaResolvesPointerIntoProperties 绿 | 待收 | ✅ 收编 `f2ae7bdec`（(#4561 review)，author=yetone 零署名族） | 11-01 核验 |
| #4563 | `438e2b4b`→**`7b42e98a1`**（hunt108-f-keychain-write-fail，rebase 后 force-push 原分支名）| 初批 CONFLICT（signin.go 上游 #4473 rework 漂移）→ 已 rebase：意图零漂移（range-diff 仅上下文重排），定向+相邻+provider 全包绿（含 #4473 新测试），issue rebase 通告帖 6544518694，新 sha256 前 16 `695939dd6962b6ec` | 待收（issue 证据已更新） | ✅ 收编 `cd0875f5a`（author=ggbdpq） | 11-01 核验 |
| #4529 | `3bd910a8`（hunt108-e-gemini-effort）| CLEAN + TestGeminiRequestEffort 绿 | 待收 | ✅ 收编 `5662c53a0`（author=ggbdpq） | 11-01 核验 |
| #4511 | `c59083f5`（hunt108-k-unrouted-408-flake）| CLEAN + 2 个 Unrouted 测试绿 | 待收 | ✅ 收编 `f811bf291`（(#4511 review)，author=yetone 零署名族） | 11-01 核验 |
| #4436 | `b497bcb3`（hunt108-i-input-modalities）| CLEAN + provider/gateway 双包绿 | 待收 | ⏳ rebase 车道在办（11-01 晨，基线前移后重排） | 11-01 |
| #4530 | `506e34c5c`（hunt108-d-slow-thinker-done）| CLEAN + TestThinkingStreams 整族 21.3s 绿 | 待收（12:33 已有 rebase 帖） | ✅ 收编 `e89a4b3c7`（author=ggbdpq） | 11-01 核验 |
| #4278 | `645e80ab`（hunt102-g-omp-pricing）| CLEAN + usage 7 定向用例绿 | 待收 | ✅ 收编 `d1b62f460`（author=ggbdpq，主题无单号） | 11-01 核验 |
| #4063 | `fbe36e57`（hunt101-w1a-host-standin）| CLEAN + redact 3 测试绿 | 待收 | ⏳ rebase 车道在办（11-01 晨，基线前移后重排） | 11-01 |

---

## 当前真在途（3 支）

| issue | 卡点 | 下一步 |
|---|---|---|
| #1448 | 维护者要真实 Cline 抓包；我方机制证据已发（6534895317） | 等抓包或维护者再判；有证据照实给，无证据不硬辩 |
| #2471 扩面 | 第一形态已合，两形态扩面 rebase 帖 19:28 发出等回合 | 轮扫盯落 |
| #2198 | 代码已在 main，关单卡在「真实 WSL 环境的人确认」 | 等条件满足；不代关 |

## 出局/不推记录（防重复推荐）

- **#4502**：上游真机自修 `73a12e8bf`（v0.1.2403，21:24，主题带单号）——发行版内解析链接、目标在 /mnt/<盘符> 下直接写 Windows 路径；Discord 帖致谢 @ggbdpq "for finding the link"。我方 rework 分支（hunt108-c）作废不再更新。判例=真机驳回后维护者按自己 spec 自修，吸收我方机理发现。
- **#4553**：维护者 10:23 v0.1.2377 同修双落出局（am 冲突=收编信号）。
- #4550：维护者两轮自修（v0.1.2387 `70d50254c` + v0.1.2391 `d6e111638`，主题带单号），报告人补样本跟进中。
- #4454：我方 waive（10-31 12:04）——上游 `cae785a37` v0.1.2155 已修（chat probe 发 max_completion_tokens）。
- #4259：报告者分支在先我方让渡（hunt102 判例）在案；10-31 13:08 第三方 xyb 另发 CLI patch（4d0db6a），如需可走「第三方修复验证背书」形态，本轮未推。
- #4261：上游 `cae785a3` 另路覆盖，只发确认帖不重推。
- #3020：上游自修，我方批测漏查（教训=对账双层查）。
- #4558：维护者先落地 v0.1.2378，让坑。
- #4559：维护者亲单测试保真单（自留族不催）。
- #2642：上游 compaction 区大改，鲜度未重核不推。
- #2829：declines 留档，分支备用不再推。
- #4063（11-01 Discord 补充理由）：维护者定设计红线——打码按值在协议里的位置判断，不按键名或主机名；按 .example 类主机名放行会让真实数据漏出去。**非环境门槛而是规则分歧，不再推**。
- **#4106（11-01 r8 审后剔除，返工候选非终局）**：维护者整批亲审时核过 sha256 但剔除——「its test isn't red without the fix, so it doesn't show that the memo is what failed here」，并给代码级解释：`InstallSkills` 设 `Own`（skills.go:1432），`editState` 走 `onlyInstalled` 分支，故测试无修复也绿、未锁住 libraryHash memo 失效。命中 r8 池备注「老支出帖前必须过 RED-on-clean-main 覆盖判定闸」的漏网例。**下一步先查他是否自修**（10 §23 自修窗口小时级；回核时今日 59 commit 已扫无 skill_changed 落点），再按其指引重写会红的测试、同分支 squash 更新 sha256 与 issue 证据。

## 第七轮（2026-11-01 帖，20 支 = 14 用户报 + 6 维护者亲单；批测基线 f598edf6d）

> 背景：r6 后维护者 Discord 两帖（22:33/01:33）=两批逐支审（核 sha256/读每行/旧代码验红/跑全量）+10 收署名保留+3 拒给 spec。r7 池=10-31 下午 rebase 续命零回合的老存货 + hunt114 #4593 + #3269 新半边。#4574/#4436 rework 均已落（#4574 `d3d92ddcfc` 帖 6548846045；#4436 `51775fe86c` 帖 6548955764，InputsSaid spec 全兑现）；#3508 批测 CONFLICT（docs/library.md 上游 20482d71f 漂移）出局本批待 rebase。

| issue | 分支 | am 结果 | 报告人 |
|---|---|---|---|
| #4593 | hunt114-b-4593-official-alias（`afd737c7f`）| CLEAN + 抽测 2 绿；**11-01 重排→`02259bb19`**（[refresh 帖 6548917524](https://github.com/yetone/magpie/issues/4593#issuecomment-6548917524)） | chowyuan1314 | ✅ `96a37ee5e`（ggbdpq） | 11-01 深夜核验 |
| #3269 新半边 | hunt113-e-3269-versioned-install（`2f56bf2ce`）| CLEAN + 抽测 2 绿 | Tony-ooo（10:28 确认复现）|
| #2855 | hunt46-b-reasoning-content-openai（`da6393d36`）| CLEAN；**11-01 重排→`486c3381f93b`**（[refresh 帖 6548916755](https://github.com/yetone/magpie/issues/2855#issuecomment-6548916755)） | qq406175258-del（19:36 补新面孔：跨模型切换 400，帖内请维护者判） | ✅ `5032d3ade`（ggbdpq）+`be689b883`/`4beb43991`（yetone 追补） | 11-01 深夜核验 |
| #2718 | hunt57-d-rest-paths（`4a1d0a238`）| CLEAN + 抽测双包绿；**11-01 重排→`ed260e0e8`**（[refresh 帖 6548871500](https://github.com/yetone/magpie/issues/2718#issuecomment-6548871500)） | parkavenue9639 | ✅ `78c92bb85`（ggbdpq）+`4d0bb7aeb`（Edward4226）+`60b2d94c4`（yetone） | 11-01 深夜核验 |
| #2946 | hunt48-b-redact-gaps（`c2d27af85`）| CLEAN；**11-01 重排→`24a93c30b`**（[refresh 帖 6548902028](https://github.com/yetone/magpie/issues/2946#issuecomment-6548902028)） | XcodeFish | ✅ `9a05a7bce`（ggbdpq）+`45385f0ee`（yetone） | 11-01 深夜核验 |
| #3526 | hunt81-a-3526（`f03b170666`）| CLEAN；**11-01 重排→`bd2e55976`**（[refresh 帖 6548904177](https://github.com/yetone/magpie/issues/3526#issuecomment-6548904177)） | Edward4226 | ✅ `78632d4b8`（ggbdpq，带 Edward4226）+`cbefb6598`（yetone） | 11-01 深夜核验 |
| #2955 | hunt47-c-compact-developer（`7e0094b8f`）| CLEAN + 抽测绿；**11-01 重排→`aeb553a9c`**（[refresh 帖 6548890786](https://github.com/yetone/magpie/issues/2955#issuecomment-6548890786)） | ShawnMa123 | ✅ `6f041c292`（ggbdpq） | 11-01 深夜核验 |
| #3289 | hunt65-a-3289-rest-max（`a611bb3c7`）| CLEAN；**11-01 重排→`d419cab3b`**（[refresh 帖 6548883700](https://github.com/yetone/magpie/issues/3289#issuecomment-6548883700)） | wjq990112 | ✅ `18387b93b`（ggbdpq，带 wjq990112）+`27099f9fc`（yetone） | 11-01 深夜核验 |
| #2873 | hunt48-e-cutshort-retry（`e401b3b28`）| CLEAN；**11-01 重排→`1c60ec38b`**（[refresh 帖 6548851568](https://github.com/yetone/magpie/issues/2873#issuecomment-6548851568)） | L-xiaoyao | ✅ `075dc3247`（ggbdpq） | 11-01 深夜核验 |
| #3197 | hunt59-d-3197-midstream-fail（`1e0562417`）| CLEAN；**11-01 重排→`cb25566a5`**（[refresh 帖 6548870304](https://github.com/yetone/magpie/issues/3197#issuecomment-6548870304)） | YonQua | ✅ `70a40aaa0`（ggbdpq）+`b68c89f39`（yetone） | 11-01 深夜核验 |
| #2969 | hunt49-b-tool-case（`e058c0b44`）| CLEAN；**11-01 重排→`3227fdc36`**（[refresh 帖 6548909730](https://github.com/yetone/magpie/issues/2969#issuecomment-6548909730)） | Beyfish | ✅ `5ebceee2d`（yetone 重写） | 11-01 深夜核验 |
| #2887 | hunt47-d-shape-failover（`f76263939`）| CLEAN；**11-01 重排→`74a74d87a`**（[refresh 帖 6548894313](https://github.com/yetone/magpie/issues/2887#issuecomment-6548894313)） | Gaudi-XIX | ✅ `f1545e147`（ggbdpq） | 11-01 深夜核验 |
| #3377 | hunt67-b-3377（`270deaf0a`）| CLEAN；**11-01 重排→`8b53eeb81`**（[refresh 帖 6548880840](https://github.com/yetone/magpie/issues/3377#issuecomment-6548880840)） | Azir-11 | ✅ `5b63dfd1a`（ggbdpq，带 Azir-11）+`e4384fc3c`（yetone） | 11-01 深夜核验 |
| #3055 | hunt58-a-3055（`749f988ef`）| CLEAN；**11-01 重排→`2e2c900fa`**（[refresh 帖 6548928620](https://github.com/yetone/magpie/issues/3055#issuecomment-6548928620)） | ArakawaHenri | ✅ `1cf66e4b1`（ggbdpq） | 11-01 深夜核验 |
| #2492 | hunt31-c2-prov-plugin-temp（`b172045e2`）| CLEAN；**11-01 重排→`2a4f868ce057`**（[refresh 帖 6548829832](https://github.com/yetone/magpie/issues/2492#issuecomment-6548829832)） | yetone（亲） | ✅ `c26d16018`（ggbdpq） | 11-01 深夜核验 |
| #2974 | hunt47-a-reasoning-dup（`05c9955ef`）| CLEAN；**11-01 重排→`a4639a597`**（[refresh 帖 6548938607](https://github.com/yetone/magpie/issues/2974#issuecomment-6548938607)） | yetone（亲） | ✅ `0b9727ec9`（ggbdpq） | 11-01 深夜核验 |
| #3153 | hunt58-c-3153-grok-toolchoice（`4c497549e`）| CLEAN；**11-01 重排→`c1d9e689bec5`**（[refresh 帖 6548840133](https://github.com/yetone/magpie/issues/3153#issuecomment-6548840133)） | yetone（亲） | ✅ `a6de2a15e`（yetone 重写） | 11-01 深夜核验 |
| #3382 | hunt68-a-3382（`b30f3986b`）| CLEAN；**11-01 重排→`e19cc2537e98`**（[refresh 帖 6548886044](https://github.com/yetone/magpie/issues/3382#issuecomment-6548886044)） | yetone（亲） | ✅ `9c8636a35`（ggbdpq） | 11-01 深夜核验 |
| #3881 | hunt100-b-3881-update-tempdir（`2cdb83a5d`）| CLEAN；**11-01 重排→`17bf07e0ef05`**（[refresh 帖 6548897102](https://github.com/yetone/magpie/issues/3881#issuecomment-6548897102)） | yetone（亲） | ✅ `e43d67d74`（ggbdpq），issue 已关 | 11-01 深夜核验 |
| #3484 | hunt80-d-3484（`45eada8cc`）| CLEAN；**11-01 重排→`9203bb89df93`**（[refresh 帖 6548903634](https://github.com/yetone/magpie/issues/3484#issuecomment-6548903634)） | yetone（亲） | ✅ `3cfba2e37`（yetone 重写） | 11-01 深夜核验 |

收编双层查（11-01 晨，tip f598edf6d）：21 支单号 grep 零真命中（#3269 命中为第四轮老收编 6f435677c；#3881/#3484 命中提交主题与单无关，以 issue 末评为准未收）。

## 第八轮（2026-11-01 小批量帖，终版 10 支 = 3 用户报 + 7 维护者亲单；批测基线追至 697335d8e）

> 模式切换（用户指令）：r8 起 10 支整批。候选源=cherry 对账（322 分支→256 支含重写误报）+GraphQL 末评判读，剔 9 支早已收编老单。**淘汰 4 支**：#2316（gateway 三文件大改区 CONFLICT；后经判定闸确认已被上游 6f6b7d407 覆盖，报废）/​#3161（gateway.go CONFLICT；判定闸确认被 ef0a5c673 覆盖，让位帖已发）/​#3097（docs 一行冲突，普通 am 会卡，待 rebase）/​#3440（i18n.js+index.html 真冲突，待 rebase）。#2318 patch 完整性待核、#2607 三方僵持慎推，入 r10 池。对账教训：宽 grep "#N" 会命中维护者提交正文里的预存红引用（794625693 引 #4109、d05482bab 引 #4247），紧格式 "(#N)" 复验定性。

| issue | 分支 | am + 测试 | 报告人 | 落地提交 | 最新状态（11-01 r8 回核）|
|---|---|---|---|---|---|
| #2833 | hunt44-b-gw-alma-compact（`3d8ed856`）| CLEAN + TestRuleCompactAlma 等绿 | jueda12 | ✅ `f0ff90516`（ggbdpq）+`15ffd3b68`（yetone 追补 Alma 0.4.335 首个压缩 prompt，三 prompt 全收）| v0.1.2520「from gua's patch (thanks, ggbdpq)」；open 等 jueda12 真机确认 |
| #3052 | hunt58-i-3052-bili-headers（`1fd206c7`）| CLEAN + TestForwardOnceCarriesBiliHeaders 绿 | gunduziba | ✅ `ee031e953`（ggbdpq）+`73528a9a0`（review 收窄：仅 /bili/ 代理形式转发，signed-in account 不带）| v0.1.2520；open 等 gunduziba 确认其 provider URL 形态 |
| #3852 | hunt95-j-3852-zcode-schema（`404c13f9`）| CLEAN + ZCode 4 测试绿 | OrangerXu | ✅ `bc7d83391`（ggbdpq）+`9be72c948`（每级补 budget_tokens+用户自设 level options 保留）| v0.1.2520；push 自动关后维护者重开等 OrangerXu 真机确认 |
| #3205 | hunt59-c-3205-kimi-reftype（`4b3b8083`）| CLEAN + TestKimiToolRefTypes 族绿 | yetone（亲，产品 bug；skygunner fork 10-22 已逐字采纳验证）| ✅ `7bdf08f18`（ggbdpq，Kimi 规则收窄到 Kimi）| v0.1.2520，push 已关 |
| #3867 | hunt95-h-3867-kimi-enum-items（`ae83e1df`）| CLEAN + Kimi/Gemini/Antigravity 4 测试绿 | yetone（亲，产品 bug）| ✅ `837ea5f56`（ggbdpq，同上收窄到 Kimi）| v0.1.2520，push 已关 |
| #4107 | hunt101-w1b-4107-handover-hang（`d3817a14`）| CLEAN + TestGiveKeepsTheListenerNonblocking 绿（修 handoff_unix.go 产品代码）| yetone（亲，测试挂死→产品根因）| ✅ `c313a906f`（ggbdpq，as written）| v0.1.2520；open 观察 43m hang 不复发 |
| #4247 | hunt102-f-4247-library-applied（`c52c88e0`）| CLEAN + library/cli 双包绿（修 save() 丢全零值 applied 条目=产品 bug）| yetone（亲）| ✅ `71f26a600`（ggbdpq，as written）| v0.1.2520；维护者点名竞态未终结（早前 cli 测试的后台 Sync 串 HOME、首次 sync 建 library.json）留 open |
| #4245 | hunt102-c-4245-stall-deadline（`21fbee22`）| CLEAN + TestStalledAnswer 族绿 | yetone（亲，稳化）| ✅ `0d76d16ec`（ggbdpq，as written，test only）| v0.1.2520；open 待数个全量套件确认红消失 |
| #4106 | hunt101-w1c-4106-skill-link（本地 ref）| CLEAN + library 2 测试绿 | yetone（亲，稳化）| ❌ 审后剔除 | sha256 对上但「its test isn't red without the fix」不收——测试未锁住 memo 失效（见出局区）|
| #4113 | hunt101-w2b-4113-cgroup-walk（本地 ref）| CLEAN + cgroup 测试绿 | yetone（亲，稳化）| ✅ `9a951eb03`（ggbdpq，as written）| v0.1.2520；open 待 Windows 全包跑一遍 |

r10+ 池（待批测/判定闸）：用户报 #3097(rebase 中)/#3440(rebase 中)/#1677/#1742/#2187/#2318/#2352/#2373/#2377/#2380/#2591/#2607(慎)/#2813/#3045/#3193/#3380/#3510；亲单 #3787/#3860；GUI 稳化长尾 #3360/#3473/#3476/#3478/#3479/#3483/#3498/#3500/#3501/#3509/#3524/#3525/#2686/#2547。**老支（hunt25-60）出帖前必须过 RED-on-clean-main 覆盖判定闸**（r8 判例 2/3 报废率）。

## 第九轮（2026-11-01 帖，终版 16 支 = 9 用户报 + 7 亲单；批测基线 21882a68d；车 E 判定闸实测推翻两处纸面判定后 14→16）

> **收官（11-02 晨实测）**：**12 收 4 悬**——#2471/#3097/#3440/#2591/#3045/#3787/#3860/#3508/#3498/#3478/#2547 author=ggbdpq 直提 + #3193 维护者重写；悬 #4574（spec rework 待审）/#2373/#3510/#3473（轮扫盯落不重推）。

> 双线交叉定盘：本会话 5 车批测 + 并行会话在途池普查（其 am 批测第四轮修正 format-patch 三点语法后采信）。**判定闸战果：11 支用户报老支实测报废/出列 7**——#1742（上游 31956b92f 报单当天自修，分支从未附 issue）/​#2187（429698f96 收编+维护者婉拒）/​#2318（4594d66d 收编）/​#2352（299498dec 收编，且从未有我方交付帖=台账误记纠正）/​#3380（gateway.go 冲突）/​#2813（上游 credits 三态重构，非机械重放）/​#3453（冲突）——「先判定后动手」闸 2/3 报废率再次应验。#1677 批测中途被维护者 fast-forward 收编（fd664874e，未发帖）移出。**#4436 rework 冲突出列转修复会话**。GUI 稳化长尾 10 支确认已被批量消化。#4574 rework（spec 收窄版）am 干净入批。

| issue | 分支 | am + 验证 | 报告人 |
|---|---|---|---|
| #3097 | hunt58-b-3097（`9ca56ca3`）| CLEAN + TestGeminiCompat 绿 | Davyricardo |
| #3440 | hunt78-d2-compact-copy（`bcf94a4a`）| CLEAN + i18n 4/4 绿（方向之争等维护者拍板，帖内注明）| Sinnhu |
| #3193 | hunt60-a-3193-balance-toggle（`81137247`）| CLEAN + 判定闸过（RED 实证）+ 4/4 绿 | pc418 |
| #2591 | hunt-fix-/2591-sessions-cache（`a06c48a9`）| am -3 CLEAN + 判定闸过（双红）+ 2/2 绿 | n1majne3 |
| #3045 | hunt58-d-3045-codex-images-budget（`86f9707e`）| CLEAN + 判定闸过（上游自带测试红=原症状）+ 双工具链绿 | ye4241 |
| #2373 | hunt25-x2-2373 | CLEAN（并行会话 am 实测采信）| 18565882223-beep |
| #4574 | hunt112-b-4574-desktop-context（rework 收窄版）| CLEAN + 定向绿 | rookie-ricardo（r6 驳回→按 spec 重做，履约句）|
| #2471 扩面 | hunt106-x-2471-remaining-shapes（`5cdd5c1f8`）| CLEAN（r5 已批测；rebase 帖 10-31 19:28 发出 2 天零回合，本批带催点）| esp32gallery |
| #3787 | hunt95-k-3787-desktop-notice-leak（`ff504be4`）| CLEAN + 定向+兄弟面绿 | yetone（亲）|
| #3860 | hunt99-b-3860-pii-fake-start（`18071208`）| CLEAN + pii 六触点绿 | yetone（亲）|
| #3508 | hunt79-f-3508（`e19edbee`）| CLEAN + TestCheckNames 绿 | yetone（亲）|
| #3473 | hunt79-n-3473（cli-update pill busy 半边）| CLEAN（本会话快验）| yetone（亲，单的另一半；列表半边已被收）|
| #3498 | hunt101-d-3498-otel-click（wheel 半边）| CLEAN（本会话快验）| yetone（亲，单的另一半；列表半边 95a4180c 已收）|
| #3478 | hunt80-j-3478（`6167af92`）| CLEAN + routing-groups-jump 15/15 绿 + **判定闸可推**（webkit 0/15 复红，#4470 只放宽导航未修 fit 面；首版注入差点假 PASS，修正注入点后复红）| yetone（亲，稳化；推翻并行「打折让位」纸面判定）|
| #2547 | hunt63-a-2547-search-queue（`9700d630`）| CLEAN + TestSearchQueueKeepsCodexAlive -count=3 绿 + **判定闸可推**（hold 首事件 500ms 注入 silent 红 pings=0，prod 零提交）| yetone（亲，稳化；推翻并行「自留 2/3 扣住」纸面判定）|
| #1677 | — | **批测中途被维护者 fast-forward 收编**（fd664874e 原样进 main，author=ggbdpq，未发帖）——移出本批，r9 实收将含此支 | FaintGhost |

> **11-01 深夜发帖前复核（修复会话 4 组 15 支全量重验，tip 21882a68d→9097687a3 三度前进）**：G1-G4 真 3way 落地 **14/14 CLEAN 零污染**（#3097/#3440/#3193/#2591/#3045/#4574/#2471/#3787/#3860/#3508/#3473/#3498/#3478/#2547，head 全部不动=不发 refresh 帖），#2547 叠加上游重写版测试仍 needed 实证；**#2373 出列**——报告者本人 PR `49639cd16`（我方提交后 5h）落地收编，我方另路作废（根因帖无承诺零撤帖）；**#3453 rework 级重排落地** `c51fd52cc`（基 c688211d1，三 tip 连续 RED 面未盖+gateway 全包 515s，帖 6554861224）补入用户报组第 8 支；#4436 rework 重排 `5311d1860`/#3380 重排 `ab9eddbf3`/#2813 credits 三态重写 `7c636145e` 三支亦落（各自 issue refresh 帖在案，不入 r9 主清单）。终版 15 支（8 用户报+7 亲单）可发。

出列明细：#4436（rework 冲突转修复会话）/​#3380/#3453（冲突）/​#2813（三态重构）/​#1742/#2187/#2318/#2352（报废）#3478/#2547 已被车 E 判定闸实测救回入批；扣住仅剩 #2686（覆盖未验证）；#2607（三方僵持）/​#1448（等抓包不催）。

> **11-05 悬支回写（r9 悬 4）**：#3473 ✅ `4006ac7b6`（v0.1.2583，author 保留）已收已关；#2373 ✅ 出清——报告者本人 PR `49639cd16` 在 main（主题带报告人 18565882223-beep credit），我方另路作废，issue open 挂着待关；#4574 维护者 11-01 三点详评 Not taking（heal 不治报告者现存行/丢 mark 根因未找到/关掉 heal 测试仍全绿）——指路 rework：找 `claude.model_budgets` 的丢失写入者、heal 只治 magpie 各设置会写的值、保留 /autocompact 测试，归修复队列；#3510 在途（10-29 rebase 帖后零回合，11-05 重验严格 am CLEAN @ `8bfc551ee`，六要素证据齐含 Not run 如实标注，可入下批帖）。

## 第十轮（2026-11-02 帖，终版 10 支全用户报；批测基线 85e37162e；hunt115 新交付 31 支中批测存活 10，出列 6 转 rebase）

> **收官（11-02 对账）**：**11 合并 + 1 跨仓特例 + 1 拒 + 1 改道 + 3 在途**——11 支全 author=ggbdpq（#4590/#4659/#4535/#4667/#4445/#4766/#4359/#4632/#4765/#4769 落 v0.1.2622-2626，review 笔五连实抓三缺口：中文会话 45 万字节/旁路 sign-in 边界/形状过滤收窄）；#4445/#4359 已关；**#4657 跨仓出口范本**：网关 patch 让位，修复落 Zed 插件 0.1.13（**Co-authored-by ggbdpq**）+provider 双侧；#4754 拒（probe 会让所有 Anthropic 提供方含官方 API 带上 system 句——正确形状=按提供方分型）；#4762 改道（维护者另一会话在修同题，我方 sha 留对照）；在途 #4678/#4611/#4606。**11-02 刷新：#4762 正式闭环——上游 `bee3ea675`（v0.1.2630，MinhuWang on X）自修同面，维护者 issue 已回 Fixed 帖（11-01 15:48 UTC）**。**11-05 回写：#4611 ✅ `9fdcb7c31`（v0.1.2747，as ggbdpq wrote it）已收**；#4606 修复会话 rebase 欠账未交付（分支 `hunt115-d4-4606` 仍 11-01 旧版，11-05 重验严格 am+am -3 双 FAIL=hub_mcp.go 语义冲突，非机械漂移）；#4678 证据齐全（六要素在 issue 可核查）但基线漂移（plugin/host.go:97+host.js:1760 上游动同区，双 FAIL）——两支均修复队列，补 rebase+refresh 后方可再推。

> r9 收官（11-02 晨实测）：**12 收 4 悬**——#2471/#3097/#3440/#2591/#3045/#3787/#3860/#3508/#3498/#3478/#2547 直提保署名 + #3193 维护者重写；悬 #4574（spec rework 待审）/#2373/#3510/#3473（不重复推，轮扫盯落）。hunt115 42 单（31 patch+6 诊+4 背+1 核销）全部零收编、全部 OPEN 我方末评；#4590/#4754 报告者刚回=最强催点。

| # | 报告人 | 痛点 |
|---|---|---|
| 4590 | shruru | codexTitles 选任何模型都不生效，网关仍收 gpt-5.6-luna 并 404（报告者刚回）|
| 4754 | double12gzh | provider test Anthropic /v1/messages probe 503/5xx（报告者刚回）|
| 4657 | atticuskk | Zed 插件 Google 模型带工具全 400 |
| 4659 | jinccc-ctrl | OpenAI 兼容网关带 tools 且纯文字回复时，流尾分片输出空 function_call |
| 4611 | YangNuoCheng | Claude Code bridge 同消息第二个工具调用丢失 |
| 4632 | IceCodeNew | Claude Code 系统消息被 Responses 上游 400 |
| 4762 | minhuw | claude interactive 首请求可先于 ready 发出 |
| 4765 | raphael-y7 | Codex 记忆整理用裸模型名路由到无权限账号并重试 3 次 |
| 4535 | MacroBull | LeastUsed 把 pay-as-you-go key 当最闲 |
| 4667 | leizh007 | ccusage 识别不到模型（model 显示 magpie-<hash>.anthropic）|
| 4445 | PennyVibe | Codex 自带模型经 Model Map 路由 Remote Magpie 返回错误 |
| 4769 | ump45nose | Kiro CLI 拿不到 Library 的 skills/MCP |
| 4606 | cpero139 | MCP hub 每 tools/call 重列全部上游 |
| 4766 | YLongo | masking 长会话 body 超 Privacy 扫描上限 |
| 4678 | cat-xierluo | 插件 model/usage 任务超 deadline 不取消（泄漏）|
| 4359 | yuerfu | AutoVision 不选 ID 含 name 的模型 |

**批测实录（4 车，tip 85e37162e）**：10 支严格 am CLEAN+定向全绿；6 支出列——#4611/#4632/#4762/#4765（严格 am 冲突但 **am -3 自动合+测试全绿=纯上下文漂移无语义冲突**，转修复会话机械 rebase）/​#4606（hub_mcp.go+test 冲突）/​#4769（mcp.go 冲突，上游 8f804396f 动同区）。#4678 的 TestOrdinaryCallCancelTellsTheHost 合跑挂 1/3 已定性**预存本机时序 flaky**（分支原 tip 同样挂），非本次落地造成。

## 第十一轮（2026-11-02 帖，终版 15 支 patch=16 单全用户报 13 + 亲单 3；批测基线 79f83798f，4 车 15/16 CLEAN+定向全绿，#4732 冲突出列转 rebase）

| # | 报告人 | 痛点 |
|---|---|---|
| 4587 | jinzheng8115 | Docker 网关 DSH 模型列表空：visible all 恢复提示清不掉隐藏态 |
| 4732 | zhangqingwen204 | Claude Desktop + Zhipu GLM 400 [1214] |
| 4654 | fengerweb3 | Claude 订阅 web search 走 MCP helper callback |
| 4576 | LingYingNX | davsync 慢线 POST 上传卡死 |
| 4523 | narcissux | 切全局 SOCKS5 后 Test 仍复用旧代理 H2 连接 |
| 4525+#4527 | isnine/ghjkllasdf-fake | Copilot 长输入 + 444 字符 item ID（一 patch 盖双单，合并一行）|
| 4612 | chowyuan1314 | Cursor/Grok 真实百分比被 Aside 标记盖（pointOf）|
| 4598 | Geidorf | 「不属于以上任意一项」规则仍显示没命中+日志缺分类器原始返回 |
| 4645 | Apri1qing | skills 引入/交接只留 from 标签 |
| 4412 | zminds | Grok 中转 key 拿到 Codex null-content |
| 4347 | jiawei322 | Codex takeover 丢 top-level model_provider |
| 4374 | RoyShen12 | Codex Desktop 经 Copilot 调 Gemini 400/Grok 422 |
| 4747 | yetone（亲）| MCP 写 ~/.claude.json 不吃 Claude Code 自己的配置 |
| 4743 | yetone（亲）| relayed Responses/Gemini 回复文本不可读 |
| 4740 | yetone（亲）| 付费 OpenCode Zen/Go 仍走 1.x /zen 路径 |

**批测实录（4 车，tip 79f83798f）**：15 支严格 am CLEAN+定向全绿（#4525/#4527 共用一支 `fix/4525-copilot-item-id-length` 盖双单）；唯一出列 **#4732**（fallback.go:1516 单文件冲突，am -3 复核同面，转 rebase 重发）。分支 head 与交付帖逐一核对零漂移。
回池队列：#4436/#3453/#3380/#2813（rebase 后插队）+ #2686（覆盖验证后）；#4106 消红重写中不在池。r9 悬 4 支轮扫盯落。

> **11-02 发帖前刷新（r11 未发，用户等 r10 的 Discord 末回合；基线 79f83798f→ff65ebd14 前进 3 笔）**：①收编双层查增量零命中——上游 3 笔（ff65ebd14 Zed plugin 0.1.14 / 59fdab0af gateway untrusted folder / bee3ea675 claudetui 首消息）正文零 r11 单号；全历史 grep 命中 3 条 body 引用全定性为维护者修邻近单时**指认缺口仍在**（39bade71d「Responses and Gemini relays still aren't read: #4743」/ 0b7d5f3a2「don't take the config lock yet: #4747」/ 9feb1024c「/zen/v1 and /zen/go/v1 paths are left as they are: #4740」）——零收编，三单反而更硬。②15 支分支 head 零漂移（tip subject+committer date 与产物 patch 逐支比对一致，全在 11-01 交付窗，无 force-push）。③14 支帖内 patch 严格 am @ ff65ebd14 **全 CLEAN**。④**帖稿数字漂移修正**（Documents/r11-discord.md）：「15 支 patch（16 单）13 用户报」→「14 支（15 单）12 用户报」、「15 个都已 rebase」→「14 个」——系 #4732 出列后未回改正文数字所致，发帖前最后一遍验证抓出。⑤#4732 rebase **未完成**：分支 hunt115-c-4732（11-01 17:21）与产物 patch 均旧版、严格 am 仍 FAIL——「已转 rebase」仅指任务转出，修复会话未交付，r12 插队单未就绪。判例：帖稿数字与出列状态要同步回改；「已转 rebase」≠「已 rebase」。

> **11-05 悬支回写（r11 悬 3 + r12）**：#4587 ✅ `3b7fe8e5f`（v0.1.2652，commit as it was）、#4576 ✅ `a73df419d`（v0.1.2652）双收（11-01 维护者已发 Landed 帖，台账漏记此次补账）；#4740 held（维护者：等付费 key 在新路径可用的证明，非驳回，我方无法单方面推进）；r12 帖 #4436 ✅ `f0b9c8af9`（v0.1.2659，author kept，InputsSaid spec 履约落地）——r11/r12 在途全部出清。#4732 修复会话 rebase 至今未交付（11-05 分支未动）。

## 第十二轮（2026-11-02 帖，仅 1 支；批测基线 f1eeeb8fd）

> r11 收官（11-02 实测）：**11 收 3 悬**——#4523/#4525+#4527（主题行 (#4525, #4527) 双单）/#4612/#4598/#4645/#4412/#4347/#4374/#4747/#4743 全 author=ggbdpq；悬 #4587/#4576/#4740 轮扫盯落。#3453 被收（8a4e32feb 重写带单号）；#2686 出清（85eef5d87 同题修复+正文点引，奥卡姆出清）。r12 实盘仅 #4436：#3380（docs 行）/​#2813（compacting.go+test）merge-tree 再冲突（连续三轮撞同区）、#4654/#4732 未 rebase——四支全在修复会话队列。

| issue | 分支 | 批测 | 报告人 |
|---|---|---|---|
| #4436 | hunt108-i-4436-input-modalities（InputsSaid rework，merge-tree OK@f1eeeb8fd）| 干净 + r6 驳回 spec 履约 → ✅ `f0b9c8af9`（v0.1.2659，author kept，11-05 回写）| ktKongTong |

## 第十三轮（2026-11-03，r13 重写版 11 支逐支审 + r14 整批帖 9 支**一夜全收**）

> 15 支首版未发即被对账轮挤出（13 支已被收编，「已闭环单不复述」）；重写 11 支 still-alive 版。维护者逐支细审：#2972 held back 三理由（报告者路由没盖住/原地重问把一个 void 放大成三个/小 max_tokens 短探针被误判 empty-reply）——出推荐清单转 rework 后入 r16；#4533 Not landing（等 @WardLu 数据——11-03 数据已回：app.log 轮转掉但 0.1.2738 仍复现，可重启诊断）。其余 9 支整批帖一夜 9/9 收编：

| # | 落地提交 | 备注 |
|---|---|---|
| 4934 | `0bffc1c5d` | author 保留，超时值维护者调整为 30min |
| 4921 | `c86fa2a34` | **收 skygunner 版**（author=vincent）+Co-authored-by/正文 credit 保留我方=双 credit（对照帖奏效）|
| 4914 | `a8d36b0fa` | author 保留（rework 后 salt 方案）|
| 4910 | `8ea2d48fb` | author 保留 |
| 4928 | `0561d5352` | |
| 4917 | `29bd947c6` | |
| 4913 | `d97e52aea` | |
| 4931 | `8f6dacbf7` | |
| 4927 | `cc22efebb` | 403 文案面；**11-03 报告者 crispinzhao 新实测=坚果云对 >10MB 文件不接受 If-None-Match 条件读取（非配额/权限）**——文案面已收但行为面未修，后续候选 |

> 判例：帖后 24h 内必须跑收编对账（9/9 收编发生在对账后数小时，账面滞后是常态）；#4921 双 credit=竞速对照帖「找到+讲清」线独立兑现。
