# hunt62 Lane E：维护者通报 flaky 复现四单核验（2026-10-22）

基线 87d703c5（=upstream/main 最新，worktree /tmp/magpie-r62-e，分支 hunt62-e-flaky-verify）。
四单总状态：**#1375 的 patch 已于 10-09 合入 main（2c36d3f2）且维护者通报的红正是我方 patch 后的行；#2965/#2988 的 patch 未合入（我方分支 d7136798 / 111f9904，维护者通报的红都在旧测试上）；#2547 从无 patch（只有 10 月中的定性分析评论）。**

---

## #2965 TestRequestBuildsProvidersOnce — 判定 b（红是旧码上的，最新 main 上原机理已被 6a050eeb 吸收；我方 patch 未被否证，但其"构造红"证明已过时）

**底账**
- 单 10-19 立；我方 patch 评论 10-19 22:11（commit d7136798，分支 hunt49-a-builds-once，未合入：`git branch -a --contains` 只有我方分支）。
- yetone 两条通报都在我方评论之后、但都在**不含我方 patch、也不含 6a050eeb** 的树上：
  - 10-20 10:20，load ~380，batch dee5c9d75：`request 1 built the providers 2 times, want 1`（**不同签名**：单请求内建两次）。
  - 10-20 19:08，c8c0985df（origin/main 4bb93b325+4），全量跑：`request 2 built the providers 1 times, want 0`（**同签名** = 本单原始病）。
- 关键时间线：**6a050eeb（10-21）"the catalog a request built is kept for the next requests"晚于立单与两条通报**。HEAD 的 request_builds_once_test.go 仍是旧形态（Fatalf 在第 40 行，与通报行号吻合）。

**本地验证（macOS arm64，go1.26.8，负载 ~5-30）**
1. 干净 HEAD 构造实验：holdCatalog 在第 2 个请求取 hold 前注入 1.2s 延迟（复刻原始病：请求 2 起点在 900ms 窗内、到达 build 时 hold 已放），加 allProviders 计数 trace → **请求 2 全程未调 allProviders（AllBuilt 2→2），旧测试 PASS**（`2965-oldtest-lag-HEAD.log`）。即 kept 层（keptFor=1m）把"lag 过 1s hold"的原始触发吸收了——10-20 的红在今天的 main 上造不出来。
2. cherry-pick d7136798 到 87d703c5：干净落上（a4322ec8），`-count=8` 8/8 绿（`2965-patched-count8.log`）。patch 兼容且仍守正确的不变量（1s 内多建仍红；"request 1 built 2×"形状在新测试下依然红，不会被遮住）。

**行动建议**
- 回帖澄清分流（草稿见下）：两条通报都在 6a050eeb 之前的树上；最新 main 构造触发已不红；patch 仍可 `git am` 且兼容。等 6a050eeb 浸泡：10-21 后同签名不再现 → patch 可撤；再现 → patch 仍是对的诊断。
- "request 1 built 2 times" 形状单独记一笔：单请求两次构建，可能是 load ~380 下请求跨过 1s hold 的合法重建（旧码），kept 落地后应基本消失；若再现则是真信号。

**回帖草稿（英文，普通确认类，无尾注）**

> Both reds here (the `request 1 built the providers 2 times` at load ~380 and the `request 2 built the providers 1 times, want 0` on c8c0985df) ran on trees that have neither the patch from my comment above nor 6a050eeb, so they don't say anything about either.
>
> On current main (87d703c5, which has 6a050eeb's kept catalog), the trigger behind the original report no longer makes the old test red: I put the same 1.2s gap between the second request's start and its build (an experiment, not committed), and the request doesn't build at all now — the catalog kept across requests answers it. So the "lag past the 1s hold" shape this issue was filed for looks absorbed by 6a050eeb; worth watching for the signature after 10-21 rather than assuming it is gone.
>
> The `request 1 built 2 times` shape is a different one: two builds inside the first request. The pending test still fails on it (request 1 wants exactly 1), so nothing would be papered over; on pre-kept code a request that took over a second to reach a later look-up would rightly rebuild once the hold let go, so at load ~380 that red may be the hold working, not the #2502 bug returning. The patch from my comment still applies on 87d703c5 (`git am`, verified) and passes `-count=8`; it only re-judges a rebuild by when it was asked, so any build asked within the second stays red. Depending on how 6a050eeb soaks, I can rebase it or withdraw it.

---

## #2988 agent-update-all 固定 200ms — 判定 b（同一疾病、同一断言块；patch 未合入所以红仍在；patch 在最新 main 上验证通过）

**底账**
- 我方 patch 评论 10-20（commit 111f9904，hunt49-e-updateall-wait，未合入）。HEAD 的测试仍是旧形态：121 行 `waitForTimeout(200)`、122 行断言 "1 of 3"、123 行 codex busy=1、124 行 gemini busy=0。
- yetone 10-20（load ~550-640，alone）：origin/main dee5c9d75+4f044c24c 双引擎红在 `agent-update-all.test.cjs:105 (1 !== 0)`；另一树上 webkit 红 "the row's pill is busy in its turn" (`0 !== 1`)，chromium 绿。
- 签名对照：`1 !== 0` = assert.equal(got 1, want 0) = **gemini busy 断言**（HEAD :124）——跑到断言时已推进到第 2 步；`0 !== 1` = **codex busy 断言**（HEAD :123）——codex 的 500ms fake 已结束。两个形状都落在固定 200/300ms 睡眠窗口的同一断言块里，正是本单的病（跑赢时钟）。行号 105 与 HEAD 124 的差是 yetone 本地批次的位移，消息签名是决定性的。

**本地验证**
1. HEAD（旧测试）空载：chromium+webkit 18/18 绿（`2988-oldtest-HEAD-idle.log`，34.8s）。
2. HEAD + 2× 核数烧机（本机 load ~20-30，远低于通报的 550-640）：chromium 9/9 仍绿（`2988-oldtest-HEAD-load.log`）→ **本地不可复现**，判定靠签名对照。
3. cherry-pick 111f9904 到 87d703c5：干净落上，chromium+webkit 18/18 绿（`2988-patched-HEAD-idle.log`）。（playwright 1.57.0 装在 /tmp/pw157，NODE_PATH 引用，未进仓库。）

**行动建议**
- 回帖附和分流（草稿见下）：两种形状都属本单修护面；patch 在最新 main 上已验证；负载复现条件本地够不着，明说。

**回帖草稿（英文，普通确认类，无尾注）**

> Both shapes in this batch are the assertion block this issue is about, read at an uncontrolled offset from the click: `1 !== 0` is the gemini pill's `count, 0` — the run was already on step 2 when the assertions read the pills — and webkit's `0 !== 1` ("the row's pill is busy in its turn") is the codex pill the other way, its 500ms fake already done. Both mean the click-to-assert path outlasted the fixed 200ms/300ms sleeps, which is the race the patch in my comment above removes: the test waits for the states it asserts, and the fake's length is a knob set to 1500ms.
>
> The patch still applies on current main (`git am`, verified on 87d703c5) and passes 18/18 on both engines here. I could not reproduce the red locally (my box reaches load ~20-30, the reports are at ~550-640), so this is by signature, not by run.

---

## #2547 TestSearchQueueKeepsCodexAlive/silent — 判定 c（同签名复现 = 我方诊断维持；无 patch 可失效；修复仍缺主）

**底账**
- 我方只有定性分析评论（10 月中，中文，已在帖内）：silent 子测试的病是**首窗墙钟敏感**——pings 只在翻译后的 in_progress 到达客户端时计数，300ms idle 计时先于请求入队启动；负载下第一个 KAlive 调度超过 300ms → cancel → pings=0。同族先例 3f4287e6（TestQueuedStreamKeptAliveForTheMinute）。修法方向：先等状态同步点再启动 300ms idle，或单独放宽首窗。
- yetone 10-19（c1e3afc24，load ~330-420，`-p 4` 全量）：`search_queue_test.go:139: silent upstream covered indefinitely: pings=0 complete=false`——与原始报告**完全同签名**（同测试、同子测试、同行号、单跑绿）。

**本地验证**
- HEAD 单跑 `-count=3`：3/3 绿，silent 0.42s（`2547-alone-count3.log`），与"单跑通过"一致。
- HEAD 源码核对：search_queue_test.go:104 `idle := time.AfterFunc(300*time.Millisecond, cancel)` 首窗墙钟仍在，:139 断言未变 → 我方诊断在最新 main 上逐字成立。

**行动建议**
- 这是四单里唯一"红还会继续出"且无主的（我方无 patch 可被否证，但诊断两次被证实）。建议主线程决定是否按已有修法实现（约一个定向 patch 的量级）。
- 回帖草稿（确认 + 表示可接；**是否承诺接单由主线程定**）：

> Same shape as the original report and as the diagnosis above: pings are counted only when a translated in_progress reaches the client, and the subtest's 300ms idle timer is armed before the request has been handed to the queue — under load the first KAlive can be scheduled past that first window, the idle cancel fires, and the stream ends with pings=0 (search_queue_test.go:139 at c1e3afc24 is the same assertion that went red the first time). Alone it stays green here too (3/3 on 87d703c5).
>
> I can take it: start the 300ms idle only after a state-sync point (the request handed to the queue, which the test can already observe), or give only the first ping a wider window — the idle resets after that are data-driven and stay as they are.

---

## #1375 TestSetAnswersWhileDevinAndProvidersHang — 判定 a（我方 patch 已合入且通报的红正是我方 patch 的行；10s bound 在负载下不足，marker 有前提缺陷；升级为修复任务）

**底账**
- 我方 patch **2c36d3f2 已于 10-09 合入 main**（"tells that the set didn't wait by order, not a 1.5s clock"）：1.5s → 10s bound（:143 set / :155 state）+ landing-marker 排序断言（:162，fake devin 20s 应答）。
- yetone 10-12 起累计 10+ 条 "Seen again"，**行号 138/143/155/162 全部是我方 patch 后的形态**（对照 HEAD 源码逐行吻合）：set slow/slow-1 耗时 10.0s/10.5s/10.8s/11.5s/13.8s/24.4s/28.6s/30.9s（bound 10s），state after 11-53s；10-19（load ~500）:162 marker 也烧过一次（同跑两个 set 13.8s/13.5s，总时长 58s）；10-20（load 650-800）"failed 2 of 3 on the unchanged base commit… Still a wall-clock bound under load; nobody has taken it"。
- 关键读数（yetone 自己的记录）：**同跑内其余 set ~0.3s，仅 slow/slow-1（挂起 provider 的 pick）单点 10-31s** → 不是均匀 CPU 饥饿；"31s looks like a timeout being reached" → 指向一条真实的同步等待路径带 ~30s 超时（候选：provider 包的 30s ctx，如 account.go:1088；具体在 Pick/connect/state 的哪一步未定位）。

**本地验证**
- HEAD 单跑 `-count=1`：绿，sets 56/272/77ms（`1375-alone-count1.log`）。
- HEAD + ~1.5× 核数合成负载 `-count=2`：绿，sets 47-267ms（`1375-load-approx-count2.log`）→ 本地负载够不着 250-800，**不可复现**；判定靠签名对照（红的行就是我方 bound 的行，无歧义）。

**判定 a 的两层**
1. patch 的诊断机制在正常工作（把 1.5s 抖动噪声变成了 10-31s 真等待信号），但**它只是检测器**：底层"set slow/slow-1 偶尔同步等 10-31s"的病没修，红会一直出。
2. 我方 patch 自带一个前提缺陷：bound 触发用 `t.Errorf` 不停测试 → 总时长越过 fake 的 20s 后，:162 marker 必然误报（10-19 那次正是 :143×2 后接 :162）。marker 只在请求于 20s 窗内完成时才有证明力。

**行动建议（升级主线程决策）**
- 修复任务：定位 slow/slow-1 pick 及其后 state 的同步等待路径（候选：provider 读的 30s 超时 context；从 Pick→magpieValue→connect 的目录/账号读入手）。bound 保持为检测器。
- 小加固（可并入）：首个 bound 触发即 `t.Fatalf`，或 marker 按 elapsed 判定，消除 20s 越窗误报。
- 回帖草稿（承认 + 读数 + 方向；**是否承诺接单由主线程定**）：

> These reds are the two clock bounds from my patch above (2c36d3f2): the 10s one at set_fast_unix_test.go:143 and the state's at :155 — merged 10-09, and every report since 10-12 is one of them being exceeded at load ~250-800, always on the slow/slow-1 set. Reading the numbers the way you are: the other two sets in the same run stay at ~0.3s while this one takes 10-31s, so it isn't even starvation across the board — one set is genuinely waiting on something that behaves like a ~30s timeout. That is the residual of the original disease (a set waiting on the hung provider); the bound is working as a detector, but nothing has caught the wait itself.
>
> One flaw of mine to own: the marker at :162 assumes the requests finish inside the fake's 20s. Once a bound trip leaves the test running past that (10-19: two :143 errors and then :162), the fake's answer lands and the marker fires without proving a devin wait. That check should not run past the fake's window — fail fast on the first bound trip, or judge the marker by elapsed time.
>
> Next step I'd propose: trace what the slow/slow-1 set and the state after it can wait on synchronously (candidates: provider reads with a 30s context on the pick/connect path); the bound stays as the detector until that is found. I cannot reproduce load ~300-800 locally, so this is from your numbers plus the code paths.

---

## 附：本车道产物与环境卫生
- 日志：本目录 `2965-*.log`、`2988-*.log`、`2547-*.log`、`1375-*.log`。
- worktree /tmp/magpie-r62-e 已恢复 87d703c5 干净态（实验代码已 checkout 还原；临时脚本已删；playwright 装在 /tmp/pw157 不在仓库内）。
- 未 push、未发帖、未评论、未改任何仓库文件（cherry-pick 验证已 reset 丢弃）。
