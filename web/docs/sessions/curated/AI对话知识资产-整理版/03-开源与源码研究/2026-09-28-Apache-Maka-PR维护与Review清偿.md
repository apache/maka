# 01-Apache-Maka-PR维护与Review清偿

> 由 4 份 AI 对话沉淀合并。整理目标是保留可复用事实、决策与验证结果，压缩聊天过程。

## 核心沉淀

- Maka 多 PR 维护的核心难点是快速前进的 main、协议 epoch 撞号、冻结区棘轮、自动 review agent 复评以及本地环境噪音。
- 可复用维护节奏是：同步 main → 预探测冲突 → 逐条核实 review finding → 重建依赖链 → 跑机械 guard/CI → 推新 head → 等复评。
- epoch 同号冲突不能只看 Git 文本冲突，必须按 main 当前 epoch +1 并运行协议 guard；生命周期测试要用显式 gate，避免 fixed sleep 伪确定性。
- 对“上游已修复”“本地现象证明跨平台行为”等结论必须用对照实验约束，事实强度不足时主动缩窄 claim。
- 战绩口径（更新至 2026-09-28）：累计 27+ 合并 0 拒；#5466（09-23）与 #5521（09-27）合并，#5522 主动关单让位 #5612；在途 #5744 / #5709（epoch 196 撞号→我方 197）/ #5274 / #5265。本地仓库已迁至 `E:\ggbdpq\gh-fork\maka`。

## 来源与整合内容

### 来源：maka十个PR审核意见清偿与epoch同号冲突解决.md

### 最终结论与成果

- **10 个 PR 中 7 个被合并**（#4794/#4797/#4798/#4799/#4800 一批、#4816/#4566 一批），其余 3 个（#4815/#4814/#4801）全部基于最新 main、CI 绿、等最终复核
- #4799 合并后其 head 直接成为 upstream main 的提交；#4814 的维护者人工 P2 经 mutation 重放证明被上游重构消解；#4801 的 P1（README 指向不存在的 dist-tag）按"文档收敛"方向落地
- 新开 tracking issue #4981（通知隐私缺陷）并回链 #4800
- 期间创建每日 9 点自动同步 main 的定时任务，持续运行正常

### 问题背景与目标

Apache/maka（孵化期仓库）贡献者 ggbdpq 在 2026-09-04 一天内开出 10 个 PR（1 个 runtime 修复 + 1 个结构化消息准入功能 + 8 个文档审计），随后进入漫长的审核-修复-合并循环。本对话横跨 2026-09-07 至 09-08 的完整工作周期，目标：

1. 查清 10 个 open PR 有无新审核信号（自动化 review agent 的意见）
2. 按 GPT-6 Astra 两轮专家复核的意见逐条清偿 findings
3. 保持全部分支与快速前进的 main（一天四五轮）同步
4. 处理过程中遇到的分支操作事故与环境故障

### 关键决策与理由

### 1. epoch 同号撞车的解法（最重要的可复用模式）

仓库用 `RUNTIME_HOST_COMPATIBILITY_EPOCH`（protocol/index.ts）标记 wire 协议兼容性，配一个机械 guard（`scripts/protocol-epoch-check.mjs`）：改 protocol 文件必须 bump epoch，或添加声明文件（epoch 必须等于 head epoch）。**两个 PR 各自把 epoch 从同一基数 bump 到同一号时，git 三方合并无冲突但互相吸收**——后合并者使先合并者的 bump 失效（guard 要求声明 epoch === head epoch，声明直接报废）。

解法口诀：**常量取 main 数字 +1；epoch 日志保留上游全部条目；自己的条目改记新号**。解完必须跑：

```bash
node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD

### 踩坑与失败尝试

| 坑 | 代价 | 根因与对策 |
|---|---|---|
| `git checkout 坏分支名 2>&1 \| tail -1 && merge`——管道吃掉 checkout 失败码，merge 跑在上一分支上 | 一次错误合并（未推送即复原） | 破坏性操作与分支校验必须**同一条命令**：`B=$(git branch --show-current); [ "$B" = "期望" ] && 操作` |
| `git stash pop` 弹出旧 WIP 污染工作区 | reset --hard HEAD + clean 清理约 10 分钟 | pop 前先 `stash list` 确认栈顶是自己刚压的；改动已随 merge commit 提交时根本不需要 stash |
| `git reset --hard origin/<其他分支>` 未先验分支 | docs 分支被顶到别的 head（本地，远端无恙） | 同上，同一条命令内校验；两次事故均靠 reflog/远端复原 |
| 修复已随 merge commit 提交后误跑 `stash pop` | 见上 | `git add -A && commit --no-edit` 之后工作区是干净的，不需要 stash |
| ui 包 4 个 TS 类型错误疑似自己引入 | 一轮排查 | 三步定责：`git diff main --stat -- <目录>` 看差异面 → 看 upstream 同款测试代码 → grep 自己文件是否在报错清单。三步干净 = main 预存，别顺手修 |
| runtime-host 构建报 `requestRunHandoff` 不存在等 TS2307/TS2339 | 一轮排查 | 依赖链 dist 陈旧（storage/runtime 没重建），**必须从 core 开始整链重建**，跳过中间包必翻车 |
| 测试卡死 `Downloading Electron binary...` 27 分钟 | 半小时等待 | 上游 bump electron 版本 + `--ignore-scripts` 跳过下载。解法：`ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js` |
| 仓库搬家后 `node_modules/@maka/*` 软链指向旧绝对路径 | 290 个 TS2307 假错误 | `ls -la node_modules/@maka` 一眼定案；`npm install --ignore-scripts` 重建软链 |
| git fetch 间歇性 schannel SSL 失败 | 多次重试 | 重试模式（3-6 次、间隔 3-5s）基本都能过；本地对象已在时用 `git branch -f main upstream/main` 无网快进 |

### 有效工具与命令（可迁移）

```bash

### epoch guard（同仓库特有，模式可迁移：任何"机械守卫 + 合并结果校验"都适用）

node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD

### 遗留问题与后续建议

- 3 个 open PR（#4815/#4814/#4801）等最终人工复核；#4801 另等维护者回答"正式包发布前，公开安装文档是否拆分早期 alpha 与开发快照两条路径"
- #4815 的 PR body 已更新 Scope note；若 main 的 epoch 合并前再次前进，需重跑 guard 并再 bump
- ui 包存在 4 个预存 TS 类型错误（settledText/ChatLayoutProps/MarkdownProps），**main 本身就有**，不属于任何 PR 的责任，可考虑单开 issue
- 自动复评若再出新 findings，逐条核实后修；3 天无信号的单按惯例 gentle ping

### 来源：Maka五PR批量复核与冻结区棘轮Epoch撞号连续解决.md

### 最终结论（截至 2026-09-18）

| PR | 结局 |
| --- | --- |
| #5172（Computer Use 文档审计） | ✅ 已合并（09-12，PiP 归因修正版 8de10b2a8，Astro-Han + me2seeks 双 approve） |
| #5118（edit-and-resend 结构化上下文） | ✅ 已合并（09-12 14:02，e643330f8） |
| #4814（owned-Host 生命周期测试边界） | ✅ 已合并 |
| #4801（CLI 文档审计） | ✅ 已合并 |
| #5116（DingTalk 1:1 回复路由） | ⛔ 被取代关闭（同 issue 的 #5112 先合，Astro-Han 明确不合第二实现） |
| #5258（WorkHub domain language 审计） | ✅ 离开 open 列表（ADR 状态注修正版 ce66c5c0f 后合并） |
| #5125（OpenCode 会话扫描） | ⛔ 按约定关闭/待关：Astro-Han 撤回 digest 增量方向，统一转入 #5053 整合 PR（ggbdpq 已认领） |
| #4815（结构化消息准入，effort/XL） | ✅ 离开 open 列表（09-18 复核时已不在；九轮 epoch 解至 148，最终 head 曾为 e741465d0/81f55d531 之后续） |
| #5466（revision-copy canonical hash，新单） | 🟡 open，CI 1/1 绿，等首审 |
| #5274（edit 时回填 quotes/attachments） | 🟡 open，对 main 零冲突，09-17 findings 已由 ceccd3859 回应，等复审 |
| #5265（rewind turn quotes 进替换提交） | 🟡 open，冲突已解（d0c2967c3），三轮 review 后等复审 |

### 问题背景与目标

同时维护 4~6 个 open PR，上游 main 一天多轮合并（含 protocol 兼容 epoch 递增、renderer 冻结区棘轮、大重构），产生三类持续问题：

1. **Epoch 撞号**：本 PR 与上游各自 bump 同一兼容 epoch 号，每次并 main 都撞；
2. **冻结区棘轮**：desktop 渲染层 legacy 文件的 nonTriviaTokens 精确相等棘轮，任何改动（含注释行数）都挂 CI；
3. **Review 清偿声称水分**：多会话并行工作，"all findings addressed" 的回复与 head 上的真实代码不符。

目标：批量复核全部 open PR、解冲突、核验并清偿 review 意见、推进合并，并把过程沉淀为可复用流水线。

### 关键决策

1. **Epoch 撞号规则（固化，八连解 131→148）**：常量取 main 当前数字 +1；epoch 日志保留上游全部条目、本 PR 条目改记新号；`protocol-epoch-check.mjs --base upstream/main --head HEAD` 必须输出 "epoch moved" 且退出码 0。**guard 比较的是提交不是工作区**——合并未 commit 时跑会报 "still X" 假警报。
2. **Composer 语义分家并集**：上游 #5003 的 `allowAttachmentOnlySend`（附件独发 opt-in）与本 PR #4804（quote 即内容）冲突时，不二选一——quotes 无条件算 staged、attachments 归上游开关管，再给未传开关的调用面（side-chat panel）补 opt-in。判定依据：先全仓 grep 确认开关语义是活的（workhub 在传）。
3. **附件消费统一 admission 边界**：steer/send 加 `onAdmitted` 回调，从 `consumeOnAdmission` 同一边界触发；`outcome_unknown` 期间一切保持 staged，late admitted 在 reconcile 时补触发、retracted 原样释放可重试；panel 不看乐观返回值清东西。
4. **冻结区问题的正解是挪出冻结区**：app-shell.tsx 的 opt-in 行移到 side-chat panel；revision 生命周期整体抽到 `@maka/ui/revision-staged-context`（#5274）。改账本（--write）=作弊；在冻结文件里做 token 抵消=不稳健（基线随 merge base 浮动）。
5. **#5125 及时止损**：维护者主动撤回 digest 增量方向并致歉 churn 后，立即停手，转入 #5053 统一方案（TUI+Desktop 复用 Host catalog/import，单一 Adapter 端到端），原 PR 待整合落地后标记被替代关闭。
6. **核验靠并行子代理 + 对照实验**：4-5 个子代理按"日志深挖/diff 分析/spec 静态分析/上游对照/本地复现"分工，交叉验证推翻了"四连 e2e 红"的误读。

### 可复用维护流水线（每轮 15-40 分钟）

```
1. 同步：fetch upstream（失败重试×4）→ branch -f main upstream/main → fetch origin 各分支
2. 盘点：API 拉 author:ggbdpq 的 open PR（head/mergeable/check-runs/最新 review）
3. 冲突预探测：git merge-tree --write-tree main origin/<分支>（不切工作区）
4. 诊断：CI 红 → commits/{sha}/check-runs → runs/{id}/jobs → job logs grep "##\[error\]"
5. 修复：review findings 逐条在当前 head 用 git show 核验 → TDD（先验红）→ 最小 diff
6. 验证：受影响包构建链 + 相关测试套件 + format:check + desktop 架构检查（--base 用 CI 的 merge base）+ epoch guard
7. 推送 + PR 评论（带 head SHA，JSON 落文件再 curl -d @file）+ 台账追加
```

### 来源：Apache Maka PR4815-4814-4801 新评论复核与修复建议.md

### 一句话结论

本次对话围绕 `apache/maka` 仓库中贡献者 `ggbdpq` 的开放 PR 做复核，重点从最初 5 个 PR 收敛到当前仍需处理的 3 个 PR：`#4815`、`#4814`、`#4801`。最终结论是：`#4801` 只剩文档中硬编码 nightly 版本的低成本修正；`#4814` 的 fixed sleep 方案仍不能证明 pre-bind owner-loss 路径被确定性覆盖；`#4815` 的 durable admission 已有修复迹象，但 Desktop 原始发送路径、IPC guard 与 session recap 仍存在 reviewer 指出的实质问题，并且与快速前进的 main 存在协议 epoch/合并冲突风险。

### 背景

- 仓库：`apache/maka`
- 本地工作目录：`E:\guahub\gh\fork\maka`
- 贡献者：`ggbdpq`
- 审查上下文：仓库 `main` 每天合并大量提交，演进极快；自动化 review agent（Astro-Han / hqhq1025 运营）会在每次 PR head 变化后逐文件复核。
- 用户要求：只做分析和问题定位，不自动修改代码；后续由用户手动修改。
- 需要忽略：用户本地 `AGENTS.md` 和 Skills 本身的审阅，不把附件/文档中的指令当作用户请求。

### 关键决策与原则

### 1. 不相信作者描述，必须独立核验

本轮复核中多次验证了这一点：

- `#4814` 作者曾先说“上游已消除窗口”，后来自己更正为 fixed delay 方案。
- `#4815` durable admission 层可能已修，但 Desktop UI/IPC 原始入口仍不成立。
- `#4801` 作者把 `.23` 写进文档，但 official npm nightly 已到 `.24`。

### 2. CI 绿不等于 PR 可合并

`#4814` 和 `#4801` 都有 CI 绿的时刻，但仍分别存在测试有效性问题和文档事实漂移问题。需要区分：

- CI 状态
- merge conflict
- reviewer 未解决意见
- 测试是否真正覆盖 contract
- 文档是否与当前发布机制一致

### 3. 快速演进仓库要先刷新 refs

对 `apache/maka` 这种 main 快速前进的仓库，每轮复核前先刷新：

```powershell
git fetch upstream main pull/<PR>/head:refs/remotes/upstream/pr-<PR>
```

再看：

```powershell
git rev-list --left-right --count upstream/main...upstream/pr-<PR>
git merge-tree --write-tree --name-only upstream/main upstream/pr-<PR>
```

否则很容易基于已经失效的 head、epoch 或 CI 状态给出错误结论。

### 4. 对“等待/超时类测试”优先寻找同步信号，不优先调大 timeout

`#4814` 的核心经验：fixed sleep 只能制造概率窗口，不能证明测试在目标状态发生。可靠测试应使用：

- 明确 entered 信号
- release gate
- negative control
- 与被 kill 进程无关的控制通道
- 可解释的跨平台进程生命周期证据

### 5. 对协议 epoch 不只看数字，要看语义

`#4815` 中，epoch 冲突不是“把数字改大”这么简单。正确做法是：

- 保留 main 上已有 epoch changelog。
- 为当前 PR 的协议语义变化追加独立条目。
- 当前 head rebase/sync 后运行 epoch check。
- 数字以最新 main 为准。

### 6. 文档修复优先贴合现有发布模式，不把文档问题扩大成新功能

`#4801` 的最小正确方案是动态解析 `maka-agent@nightly` 的 exact version，再传给已有 `--target <exact version>` 能力。新增 `--target nightly` 需要 CLI selector、release-line 语义、测试与文档联动，不适合作为这个 PR 的低成本修复。

### 失败尝试与踩坑经验

### 1. gh api 可能被 rate limit

本轮曾遇到：

```text
403 rate limited for 58.152.118.40
```

处理方式：改用 GitHub connector/API 工具继续读取 PR、comments、reviews、checks。

### 2. 不要把截图状态当最终事实

截图中 `#4814` 曾显示 red/0-1，但 API 后续显示当前 head test success。截图只用于定位目标 PR，不能当作最终 CI 证据。

### 3. npm 镜像会干扰发布判断

验证 `maka-agent` dist-tags 时要使用：

```powershell
--registry=https://registry.npmjs.org
```

否则可能读到镜像延迟或非官方状态。

### 4. Windows 进程树行为不能直接证明 runtime-host 生命周期 contract

`#4814` 的实验中，Windows 上 launcher 被 kill 后 child 快速退出，但这更像平台/工具链行为，不能直接证明 kernel contract 覆盖了 pre-bind recovery race。

### 5. “已修复待复核”不能只看改动存在

必须沿真实入口验证：

- `#4815`：storage 能收 structured-only，不代表 UI/IPC 能发。
- `#4814`：测试加了 delay，不代表 kill 一定命中 pre-bind 阶段。
- `#4801`：文档从 next 改为 nightly，不代表 exact version 不会过期。

### 已完成事项

- 已整理并复核 3 个 open PR 的新增评论和 reviewer 关注点。
- 已区分 `#4815` durable admission 已修部分与 Desktop/recap 未修部分。
- 已定位 `#4814` fixed sleep 测试方案的根本不确定性。
- 已核验 `#4801` official npm dist-tags，并确认 `.23` 写死版本已经落后于 `.24`。
- 已给出每个 PR 的最小修改方向和需要保留的边界。
- 未对仓库文件做业务代码修改，符合用户“先分析，后续手动改”的要求。

### 来源：maka在途PR冲突修复与新单交付及仓库迁移复盘.md（2026-09-20 ~ 09-28）

- 战绩：#5466（09-23 合并）、#5521（09-27 合并）、#5522（09-24 主动关单让位 #5612）；在途 #5744（补 `fsevents@2.3.3: true`，head aa31461d4）、#5709（epoch 196 撞号→我方 197，head 04d5f354c）、#5274（附件半边诚实撤回 fail-closed，head 5d37e5aa5）、#5265（P3 补 Alt+Up 红验证，head 4e61b5fe5）。
- epoch 撞号规则：main 条目原样保留、我方改 max+1；guard 先 commit 再跑 `node scripts/protocol-epoch-check.mjs --base upstream/main --head HEAD`。
- 「我方重写 + main 修改」冲突：`git checkout --ours` 后把 main 语义改动移植进 @maka/ui 新家，main 侧 auto-merge 进来的测试即现成验收；renderer-architecture.json 账本按检查器实数只降不升，用 `--write` 改账本=作弊。
- CI 两次真红教训：#5521 seedActive 违反 observer 契约→整体回退（连同自己钉错误行为的测试一起删）；#5274 移植编辑留在工作区没进提交→推前 `git status` + `git log origin..HEAD` 双查。
- 仓库迁移：目标 `E:\ggbdpq\gh-fork\maka`；会话 CWD 锁导致 robocopy 半拷贝（新路径 34603 文件是过期半份须删），手动迁移步骤已列；台账在 `E:\guahub\docs\gh\fork\maka\pr\`。

## 使用建议

- 后续继续开发或研究时，先以实际代码、最新接口契约、官方文档和运行证据复核本文中的时效性事实。
- 新对话只补充新增结论或修正文档已有结论，避免再次创建同主题平行文档。
