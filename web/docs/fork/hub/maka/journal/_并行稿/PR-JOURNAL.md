
### PR-039 ｜ 四单收尾：两单合并、一单被取代关闭、一单待整合替代
- 日期：2026-09-12 ~ 09-15（09-15 复核确认）
- 结果核实（API 实测）：**#5172 已合并**（09-12 10:25，head 8de10b2a8——我的 PiP 归因修复版，Astro-Han 与 me2seeks 双 approve 后即合）；**#5118 已合并**（09-12 14:02，head e643330f8，含我的冻结区注释修正）；**#5116 被取代关闭**（09-12 14:07，Astro-Han 合了同 issue 的 #5112 并明确不再合第二实现，作者回复认可后关闭）；**#5125 仍开着**（CI success、mergeable=true），按 #5053 统一方案待整合 PR 落地后标记被替代关闭——Astro-Han 09-13 主动撤回 digest 路径的增量指导并致歉 churn，09-14 与 wutongyuonce 在 #5053 定稿方向（A-C：完整导入或失败、统一 conversation_text 契约、Adapter 单一权威），作者已认领 #5053
- 本地同步：upstream/main → 2d9843fef；本地分支快进到远端 head（feat/opencode-session-scan 9754b1421、fix/edit-resend-structured-context e643330f8）
- 经验一条：**被维护者主动撤回方向时立即停手**——#5125 几轮增量补丁后，Astro-Han 明确"pause the incremental fixes while I align the scope"，churn 的止损点不在修得更好而在及时确认新方向；同 issue 出现第二实现时要主动核对（#5116 vs #5112 双实现，先合者胜，晚的不进 review 直接关）

### PR-040 ｜ 09-18 复核：#5265 撞号解冲突（session-driver import 并集）+ 三单状态快照
- 日期 / 链接：2026-09-18 / [d0c2967c3](https://github.com/apache/maka/pull/5265)
- 现状核实：六天内另一会话大幅推进——#5274 的棘轮按 Astro-Han"checker 规则制裁"路线解决（d53b28fc5+ceccd3859），#5265 三轮 review 后新 head 8822a0911，新增 #5466（revision-copy canonical hash）；#5172/#5118 已合并（09-12）、#5116 被取代关闭（#5112）
- 改动：#5265 merge main@0169d0731——唯一冲突是 session-driver.ts 的 import 块（本 PR 的 QuoteRef+ShellRunSnapshotResult ∪ 上游新增 ShellRunStateResult），并集一行解
- 验证：依赖链全重建后 cli 测试 304 个中 252 过/52 挂——与台账"cli driver 50 + TUI 2 SIGTERM"预存清单精确吻合，非合并引入；格式检查通过；已推送
- 状态：#5466/#5274/#5265 三单 mergeable 全 true（blocked=等 review/复审）；#5274 的 Astro-Han 09-17 findings 已由 15:26 提交回应，等 re-review
- 经验一条：**rg 的 `-r` 是 replace 标志**（本轮与上次共误用三次，输出被静默改写成假内容）——递归加行号的正确写法是 `rg -n`，别把 grep 的 `-rn` 手感带进 rg；**切分支后跨包 dist 必须重建**（cli 的 52 个 TS2322/TS2355 全是 stale runtime-host dist 的假错，重建即清零）

### PR-041 ｜ 09-20 复核：#5274 撞 main 解两处冲突 + 三单状态收口
- 日期 / 链接：2026-09-20 / [#5274 评论](https://github.com/apache/maka/pull/5274)（head 070e7f4ec）
- 盘点（API 实测）：#4815 已合并（09-13）、#5125 被取代关单确认（merged_at=None 但 closed，勿再动）；open 仅 #5466/#5274/#5265，三单 CI 全绿
- #5274：09-18 的 merge 后 main 又动 → 再度 dirty。冲突两文件：`packages/ui/src/conversation-copy.ts`（main 加 turnStatus*/gitBranch*/switchWarningDismiss 等，取 main 后重放我方两 key 删除）+ `apps/desktop/renderer-architecture.json`（union 双方条目后 app-shell.tsx 按检查器实数 13081 重定价，仍低于 main 基线 13127）。验证：ledger plain 过、fixture 112/113、@maka/ui 547/547、biome 13 文件净、desktop typecheck 绿；已推送并发带 head SHA 评论
- 定性两条预存：① `attests the canonical main source` fixture 在 Windows 必挂（path.resolve 盘符前缀 vs mock 的 /fixture facade 永不相等），纯 upstream/main worktree 实证复现，Linux CI 不受影响——值得开 upstream issue；② ui dist 孤儿测试堆积（dist 234 vs src 72，09-08 旧残留引用已删导出报 SyntaxError）——清 dist 必须连 tsbuildinfo 一起（用包内 clean 脚本）
- #5265：09-17 四项修复逐条在 head a127b13e 核验属实（pi-transcript.ts:1598 提示行、applySwitchResult 失效化、/quotes clear truthful copy、blocked/two-quote/mid-turn 三类新测试），绿 + mergeable，发 gentle ping
- #5466：09-17 创建满 3 天零审零评，发 gentle ping
- 经验一条：**tsc 复合工程删 dist 不删 tsbuildinfo = 假重建**——rm -rf dist 后 build 跳过全部输出，test:dist 报 0 测试假绿；陈旧 dist 的孤儿测试会拿已删除的导出报错，先查 src 对应文件是否存在再定性，别急着当回归修

### PR-042 ｜ #5520 队列无根窗口投影缺口（新单当轮交付）
- 日期 / 链接：2026-09-20 / [PR #5521](https://github.com/apache/maka/pull/5521)（Fixes #5520，head 7b4a974e6）
- 选题：7 个未认领 issue 过四道闸——#5424 被 #5427 占坑、#5493 被认领、#5449 被 testikun take、#5425 自述"讨论非修法"、#5519 开放式设计 feature；选 #5520（当日新报、零评论、runtime-host 投影区与 #4815/#5265 知识交集）
- 根因：`session-projector.ts` 投影门 `root && queueChanged(...)` 丢弃无根窗口的 `queue_update`，`seedActive` 无根早退 `[]`——队列在此窗口 drain 永不投影，渲染端幽灵卡 retract 必 not_found 且切会话不清（服务端 `#publishCanonical` 对任意 canonical 变化都广播，锅纯在投影适配层）
- 修法（最小 diff 81+/21-）：accept 路径 queue_update 与 root 解耦（turnId 逐级回退 root→previousRoot→''，steering 合成保持 root 门）+ seed 无根也种队列镜像（空队列即"清卡"信号）；消费方本就处理两种形态，零消费端改动
- TDD：两条新测试（无根 drain / 无根 seed）修前红修后绿；投影套件 29/29、message-coordinator 76/76、execution-host-queue 16/16；biome 净、asf-headers 过
- 定性：session-subscription-client 13 挂在纯 upstream/main worktree 一模一样复现（Windows transport read side ended）= 预存环境病；execution-host-queue 首跑 1 挂（Host did not become ready 超时）单跑+全文件重跑即绿 = spawn 重度偶发
- 经验一条：**worktree 基线对照要"同构跑法"**——基线单跑 vs 分支全文件的失败集合没有可比性；先单跑定性再全文件对全文件，否则会把偶发超时误判成回归

### PR-043 ｜ #5519 运行中会话行的工作标记（新单当轮交付）
- 日期 / 链接：2026-09-20 / [PR #5522](https://github.com/apache/maka/pull/5522)（Fixes #5519，head d7808e840）
- 选题：池子见底（#5425 讨论态、#5424 被 #5427 占坑、#5449/#5493 被认领、#5500 tracking 且 main 已落 #5502）；剩 #5519（0 评论未认领，issue 自带精确勘察）
- 方案（复用阶梯全中）：不动 8px 点的颜色语义/单点设计/`sessionRowSignals`，信号 span 加 `data-working`（由既有 `isPulsing` 驱动=恰好覆盖活跃响应+持久 running），styles.css 用**既有 `maka-spin` 关键帧 + `var(--accent)`** 画环绕旋转弧；reduced-motion 退化为静态环（非运动标记，正是 issue 要的 fallback）；绝对定位不破固定 gutter
- 关键发现：`@astryxdesign/core` 是 npm 依赖（0.6.1），issue 里说的 astryx.css pulse 本仓库改不了——但依赖的 StatusDot 自带 icon prop、本仓库有 maka-spin，全部就地复用，零新依赖零账本影响
- TDD：新测试文件三用例（活跃/持久 running/静止）修前红修后绿；ui 全套 536/536；biome 净；asf 过；diff 37+/1-
- 未验证明说：动画本身的可辨识度（8px+3px 环）headless 测不了，PR 里请维护者 storybook/跑 dev-app 肉眼过一遍再合
- 经验一条：**改依赖包里的样式前先查它是 npm 包还是 workspace**——`@astryxdesign/core` 的"改 astryx.css"是死路，但它的扩展点（StatusDot.icon）和本仓库既有 keyframes 往往够用；另外 rg 的 `-rn` 陷阱这次又踩了一次（只读输出被改写，无损害），第三次了

### PR-044 ｜ #5521 CI 红三日速修：seed 画蛇添足回退
- 日期 / 链接：2026-09-20 / [PR #5521 评论](https://github.com/apache/maka/pull/5521)（fix head 5dac0705a）
- CI 三挂全在 desktop 消费方：candidate×2 崩溃（observer 造的投影快照 queue 可为 undefined，我的无条件无根 seed 直接喂进 projectQueueUpdate）+ observer×1（契约测试钉死"无根 seed 事件必须 === []"，我虚构了 queue_update）
- 修法：整个回退 seed 改动（seedActive 恢复无根 return []，连带删掉我那条 seed 回归测试），只留 accept 路径——#5520 幽灵卡的真实场景是"客户端仍订阅着（事件按 sessionId 路由，与可见视图无关）"，accept 修复已全覆盖；从未订阅过的客户端没有陈旧卡可供 seed 清理，这就是 observer 契约存在的理由
- 本地转绿：projector 28/28、observer 55/55、candidate 25/25
- 经验两条：①**验证矩阵按消费方补全**——projector 的消费方在 apps/desktop（observer/candidate 套件），只跑 runtime-host 本包 = 漏掉真正踩契约的人，"受影响 workspace"以运行时调用链为准不以包边界为准；②**回退式修复要连同自己新加的测试一起退**——钉错误行为的测试比没有测试更糟

### PR-045 ｜ 09-22 复核：两份 Changes requested 已响应确认 + #5274 三撞 main 移植式解冲
- 日期 / 链接：2026-09-22 / [#5274 评论](https://github.com/apache/maka/pull/5274)（head 204e884b4）
- 盘点：me2seeks 两份对抗式 review（#5466 洗白路径、#5265 P1 outcome_unknown 吞 quotes + P2 中性标签）已由 09-20 会话完整响应（87e605295 / cb6d10882+c07c577a7），本轮对 head 逐项核验属实（dual identity、UnknownOutcomeSubmitDriver、quotesRestoredUnknown 三语、中性 `· N quote(s)`）；#5466/#5265/#5521/#5522 对 8bde344b1 全干净，唯 #5274 四文件冲突
- 解法升级：#5274 这次不是文本并集——main 的 transcript-publish 简化（删 readSettledMessages/setMessages/abort、refreshSessions 提前、toast 先于 rollback）**移植进 @maka/ui 提取后的生命周期**，装配器与 app-shell 依赖面同步收缩；账本按检查器实数重定价（app-shell.tsx 12957→12682、revision-actions 537→482，全部 ≤ main 基线）
- 验证：全链构建绿（astryx 0.6.2 patch 补装）；arch plain 过；fixture 112/113（唯一失败仍是 Windows 预存）；ui 629/629（清孤儿后）；desktop revision 7/7、first-send 20/20、catalog 4/4；typecheck 绿；biome 净；asf 过
- 经验两条：①**"我方重写 + main 修改"的文件冲突别做文本并集**——把 main 的语义改动移植进重写后的新家（这次是 @maka/ui），main 侧 auto-merge 进来的测试就是移植验收标准；②环境类构建失败先分层定性：真类型错误（我漏删的引用）vs 依赖补丁未装（astryx 0.6.2）vs dist 落后（协议新动作）——三种病一个命令流水线治好（npm install + patches + 依序重建）

### PR-046 ｜ 09-23 复核：#5274 CI 红真因——移植编辑没进提交 + 又撞账本
- 日期 / 链接：2026-09-23 / [#5274 评论](https://github.com/apache/maka/pull/5274)（head ae023e13c）
- 盘点：五单零新评论；#5466/#5265 维持 Changes requested 等复核、#5521/#5522 干净等首审；对 6cb8c5808 仅 #5274 撞账本（单文件 3 块）
- #5274 CI 红真因：**上一轮的移植编辑根本没进提交**——merge commit 在解完冲突后立即提交，ui 生命周期/装配器/app-shell/ui 测试四个文件的移植改动留在工作区，而 204e884b4 只提交了账本+测试；CI 严格基线交叉检查立刻抓到（树里还有 session-message-settlement import，537 tokens vs 账本 482）
- 修法：a06e0430d 补提交移植（env 面收缩两依赖+abort、refreshSessions 提前、toast 先于 rollback）→ 合 6cb8c5808（仅账本冲突，取我方+检查器实数重定价：chrome-actions 408→122 等 5 处）→ ae023e13c
- 验证：全链构建 0 类型错误；arch plain 过；ui 630/630；desktop revision 7/7、first-send 20/20；typecheck/biome/asf 过
- 经验一条：**提交时序必须对齐改动时序**——"解冲突→提交 merge→继续改→只提交后续文件"会把中间态推上 CI；merge commit 应在工作区完全收敛后再建，或推前用 `git diff HEAD` 终查工作区残留。评论里预写未推送的 SHA 又错了一次，PATCH 修正——SHA 永远在 push 之后落笔

### PR-047 ｜ 09-28 复核四单：#5709 epoch 撞 196→197、#5265 P3 补 Alt+Up、#5274 正文改口径、#5744 补 fsevents
- 日期 / 链接：2026-09-28 / 四单各发评论（#5709 04d5f354c、#5265 4e61b5fe5、#5274 正文 PATCH、#5744 aa31461d4）
- 大盘：**#5466 已合并（09-23）、#5521 已合并（09-27）**；#5522 我方 09-24 主动关单（被 #5612 的设计系统 RunningIndicator 取代）；在途余 #5744/#5709/#5274/#5265
- #5709：hqhq1025 判定代码无缺陷但**与 main 双方独立把 epoch 196 分给不同变更**——按既定规则解：main 的 196 保留、我方条目改 197、常量 197，guard 过（"196 -> 197"）；usage query 13/13、stats 21/21
- #5265：driver.test 冲突是双方各自加假 driver 分支（revision.create ∪ turn.resume.start）；P3（回归测试从没发过 Alt+Up，旧实现也能过）修法=enqueueGate 持有期间补 `\x1b[1;3A`，**红验证**：拆掉 post-settle session 栅栏测试即红、恢复即绿；本地 53 挂全是 main 新测试的 /tmp POSIX 假设（Windows 预存）
- #5274：另一会话 09-27/28 已多轮响应（rebase 到 #5470 引用树、附件半边诚实撤回）；本轮只做两件——确认尾空行已消、**PR 正文改口径**（quotes=已实现，attachments=fail-closed，Host 侧留 #5109），否则描述与实现不符会一直被审出
- #5744：me2seeks P2 坐实——fsevents@2.3.3（darwin-only optional，hasInstallScript）因 Linux 扫描漏出 allowlist，补 `"fsevents@2.3.3": true`；P3（防再漂移的 CI guard）按 YAGNI 留作后续单并在评论里认领
- 环境坑两条：main 新增 workspace 后 `npm install` 补链接（antigravity-acp-plugin TS2307）；astryx 0.6.2 patch 重复应用报错=包未被 npm 重置，rm 掉重装再 apply 即净
- 经验一条：**推送前 `git log origin..HEAD` + `git status` 双查**——本轮 #5265 的占位提交事故（乱消息进了历史）靠 force-with-lease 重写收场（树一致、历史干净）；手搓多命令提交序列时每步核验 HEAD
