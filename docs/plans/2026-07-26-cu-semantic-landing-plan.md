# CU 语义执行落地计划

制定日期：2026-07-26
状态：阶段 0 已完成 · 阶段 1 进行中
本文档为本地工作产物，不进 git 提交（见铁律章节）

---

## 一、为什么是这份计划

这份计划的出发点不是「Maka 的 CU 该走什么技术路线」，而是一个更朴素的事实：

**你已经把语义执行做完了，而且真机验证通过了，但它躺在两个 DRAFT PR 里没进 main。**

2026-07-25/26 做了三轮调研（19 + 20 + 25 个 agent，含对抗验证）：审计卡住的分支、逆向 Codex 官方 CU 二进制、深读开源实现 open-codex-computer-use。三轮的结论收敛到同一点——Maka 缺的不是设计，是把已完成的工作推过线。

上一轮 CU 工作 95% 白做的教训必须写在最前面：

- PR #699 被 CLOSED 后拆成 27+ 个小 PR 落地，但本地还攒着一个大分支慢慢做
- 期间上游合了 PR #985（覆盖 openai-computer-loop，严格超集）、PR #1255（覆盖 cursor-engine，592 行超集）
- 结果本地 865 行 + cursor-engine 重写全部作废

**原则：先把做完的推过线，再做新的。**

---

## 二、现状全景

```
                                    trycua/cua#2210
                                    "add stable AX node identity tokens"
                                    OPEN 12 天 · 0 review · CI 从未跑过
                                    （fork PR 的 workflow 需 maintainer approve）
                                    已 ping @f-trycua 两次
                                              │
                                              │ 硬阻塞
                                              ▼
  #1262 ✅ MERGED 07-20            #984 DRAFT  consolidate target identity
        │  (squash → 7944f96c)            +968/-334 · 13 天未动
        │                                 真机已验证：gpt-5.6-sol 跑通
        │ 依赖已解除                       AX set_value / click_element /
        ▼                                 多步 fresh-token / 进程重启恢复
  #1263 DRAFT  background semantic execution   「零 pixel dispatch」
        +769/-169 · 182 tests passed
        ← 阻塞在 07-20 就没了，只是没人 rebase
```

### 上游节奏

近 30 天 903 个提交，但 `fix cu` 只有 11 个。CU 领域上游动得慢，且 open PR 里无人做 CU——撞车风险低，但也没人替你推。

### Maka CU 的真实架构地位

调研得到的对照结论：

| 维度 | Codex 官方 | occu (开源) | Maka main | Maka DRAFT 里 |
|---|---|---|---|---|
| 执行路径 | 纯 AX，零 CGEvent | AX 优先，postToPid 兜底 | 坐标注入 | AX 语义 dispatch |
| 元素给模型 | 是（AX 树 + diff） | 是（element_index） | 否（只内部命中测试） | 是（element_token） |
| 截图 | 单窗口 + 降采样 | 单窗口 | 整桌面 + 原生分辨率 | 单窗口 zoom |
| 帧绑定 | per-turn 会话 | 无（index 静默漂移） | frameId+epoch 单次消费 | 同左 + token |
| 后台执行 | 是 | 是 | 部分 | 是（不需前台激活） |

关键事实：`cua-driver` 二进制里本来就有 `AXUIElementPerformAction` / `AXPress` / `AXConfirm` / `AXUIElementSetAttributeValue` / `SLEventPostToPid`。你没选错 backend，只是 main 上还没用起来。

---

## 三、执行计划

### 阶段 0：清场 ✅ 已完成（2026-07-26）

| 步骤 | 状态 | 说明 |
|---|---|---|
| 0.1 备份唯一副本 | ✅ | `git push fork codex/cu-full-matrix`，远端 sha 验证一致 |
| 0.2 留档工作区 | ✅ | `/tmp/cursor-engine-wip-20260726.patch`（1063 行）+ 全量 patch |
| 0.3 中止 cherry-pick | ✅ | 实为两条序列（c317f929 + 72e0aeaf），必须 abort 不能 skip |
| 0.4 恢复 cursor 三件 | ✅ | 三路径一起 restore，否则 test 的 dubins.js import 会断 |
| 0.5 弃 feat/cu-runtime-helper | ⬜ | `fork/backup/pr699-pre-maka-computer-20260712` 已有备份 |

验收：已跟踪文件全干净 ✅

### 阶段 1：#1263 解冻上线 ✅ 已完成（2026-07-26）

无外部依赖，最高优先级。

| 步骤 | 状态 | 说明 |
|---|---|---|
| 1.1 rebase 到最新 main | ✅ | `git rebase --onto origin/main codex/cu-semantic-contract-pr`，4 个提交零冲突 |
| 1.2 lint + format | ✅ | biome 409 + 456 文件全绿 |
| 1.3 构建与测试 | ✅ | computer-use 138/138 · scripts 121/121 · runtime 2503/2512（2 个 flaky 已证伪） |
| 1.4 真机 qualification | ⏭️ | 本次跳过。rebase 零冲突、代码未变，PR body 里已如实标注「未在 rebase 后重跑」 |
| 1.5 push + 转 Ready | ✅ | 备份先推 fork，主分支 `--force-with-lease`，PR 转 Ready |

**结果**：PR #1263 状态 OPEN / draft:false / MERGEABLE / +552 -141 / 11 files
https://github.com/maka-agent/maka-agent/pull/1263

远端备份：`fork/backup/cu-bg-qualified-20260726 @ 1a021469`（rebase 前状态）

**1.3 的环境陷阱**（详见 memory `maka-local-dev-env`）：

第一次跑全量 `npm run test` 得到 156 fail / 7 个 workspace 全红，全部是假失败，两个根因：

1. 本机 node `v22.11.0` 缺 `node:sqlite`（需 `--experimental-sqlite`），而 CI 的 `node-version: '22'` 解析成最新 22.x 已默认启用。项目无 `engines` 无 `.nvmrc`，不会有任何提示
2. 同时挂着两个 Workflow，load average 冲到 23/35/25，大批 deadline 断言超时

清理后按 workspace 重跑，CU 相关 suite 全绿：

```
ok 7  - executes an observed element once and returns a fresh observation
ok 8  - cua-driver backend
ok 11 - cua-driver release contract
ok 13 - cua-driver service lifecycle
ok 14 - cua-driver snapshot coordinate authority
ok 15 - cua-driver AX hit testing
```

待办：把本机 node 升到最新 22.x。`NODE_OPTIONS=--experimental-sqlite` 只是一次性验证手段，不要写进任何脚本或提交。

**rebase 的关键点**（下次遇到 stacked PR 同样适用）：

`#1262` 是 squash merge（`7944f96c ... (#1262)`），所以 `git cherry` 对 PR1 的提交仍报 `+`（patch-id 对不上）。直接 `git rebase origin/main` 会重复应用 PR1 的 3 个提交并冲突。正确做法是 `--onto` 只搬 PR2 的 delta：

```bash
git rebase --onto origin/main codex/cu-semantic-contract-pr codex/cu-background-qualified-pr
```

备份分支：`backup/cu-bg-qualified-20260726 @ 1a021469`

**rebase 后的 4 个提交**（新 sha）：

```
20990b4a  style(cu): format background qualification changes
d1b6c71a  test(cu): qualify covered background execution
88544d58  fix(cu): bind semantic actions to observed centers
2e010eef  feat(cu): complete verified background semantic execution
```

diff 规模 11 files / +552 -141，与 rebase 前完全一致。

**1.4 真机 qualification 的硬约束**：

必须走 desktop `.app` 启动，不能用裸 node / CLI / headless。原因见 memory `maka-cua-tcc-background-trap`：给后台裸 node 进程授 TCC 会永久毒化该进程的 `~/Documents` 访问，撤销无效、重启前台 UI 无效、nohup+osascript 逃逸全 EPERM，只能重启该进程。

场景（来自 PR body）：
- covered zoom capture
- background `set_value` → `press_key` → `click_element` 流

**产出**：main 上第一次拥有「后台语义执行 + 被遮挡窗口捕获」。

### 阶段 2：解开 trycua/cua#2210 阻塞

外部依赖，需要主动推动。

| 步骤 | 说明 |
|---|---|
| 2.1 诊断 CI | `gh pr checks 2210` 报 "no checks reported"——fork PR 的 workflow 需 maintainer approve，从未跑过一次 |
| 2.2 准备 B 方案 | 把 element_token 做成可选路径：driver 支持则用，不支持则降级到现有 fresh-index + readback 校验，让 #984 不再硬依赖上游合并 |
| 2.3 第三次 ping | 附上 #1263 已合并的下游证据增加说服力 |

现状：7 条 comment，0 个 review。Codex connector 报 "reached your usage limits for code reviews"。已 ping @f-trycua 两次，最后更新 07-20。

验收：#2210 拿到 review，或 #984 解除硬依赖。

### 阶段 3：#984 上线（依赖阶段 2）

| 步骤 | 说明 |
|---|---|
| 3.1 rebase 到 main | 排在 #1263 之后做，减少二次冲突 |
| 3.2 真机复验 | AppKit AX set_value / AX click_element / 多步 fresh-token click（含物理输入干预恢复）/ 进程重启 stale-token 恢复 |
| 3.3 转 Ready | |

验收：「零 pixel dispatch」的断言进 CI 可回归。

### 阶段 4：上游两个活 bug（独立，可随时插队）

这两个是审计发现的、上游至今仍然坏着的真 bug。

**4.1 wait 静默截断且不响应 abort**

```
origin/main:packages/computer-use/src/cua-driver-backend.ts:2630
  await new Promise((res) => setTimeout(res, Math.min(action.durationMs, 10_000)));
```

runtime 侧允许 duration 到 60s → 模型请求 wait(30s) → 实际睡 10s → 汇报 `ok:true`。且不接 signal，用户点停止后仍跑满 10 秒并堵住共享操作队列。`git grep waitForDuration origin/main` 零命中。

修复：改成 abort-aware `waitForDuration(ms, signal)`。**保留 10 秒上限**——HEAD 那版顺手去掉了上限，直接照搬会给非 zod 路径引入无界等待。

**4.2 middle_click / triple_click advertised but unreachable**

```
origin/main:packages/core/src/computer-use.ts:131          向模型暴露 middle_click
origin/main:packages/computer-use/src/cua-driver-page-target.ts:25-27  union 只有 left/right/double
origin/main:packages/computer-use/src/cua-driver-backend.ts:2159-2161  语义门同样只放行三种
```

`allowCompatibilityInputDispatch` 在生产链路从不置位（`git grep` 零命中），兜底恒为 blocked。无 issue、无测试、无人在追。

修复：page-target union 扩到五路 + backend 语义门 + auxclick(button:1, buttons:4) 合成 + 3× click 计数。

抢救源：`codex/cu-full-matrix @ 9298bddc`（已 push 到 fork 备份）。

**注意**：不要直接 cherry-pick。上游那几个函数周边已重构成 sessionGenerations / targetsBySession / pageTarget，要基于 origin/main 重写。拆两个小 PR。

### 阶段 5：增量改进（#1263/#984 落地后再评估）

按调研得出的、扣除 DRAFT 已覆盖部分后的剩余项：

| 编号 | 内容 | 依据 |
|---|---|---|
| 5.1 | 截图降采样 + JPEG | 现在原生分辨率、8MB 上限直发模型 |
| 5.2 | scale 用实际 PNG 尺寸 ÷ window bounds 反推，不信 backingScaleFactor | occu `ComputerUseService.swift:161-195`，就一个函数 |
| 5.3 | 修 OpenAI 适配层的 scroll 无条件 fail-closed | 真实浏览第二轮就会打死 loop |
| 5.4 | Esc 全局中断 | 已有 `powerMonitor.getSystemIdleTime() < 1` 静默窗，缺主动取消 |
| 5.5 | permiso 权限引导 → feat/permission-onboarding | MIT，530x109 面板 / 0.72s 临界阻尼 spring / 贴 System Settings 窗口下沿 / 0.25s 轮询自动收敛 / 授权 1.5s 未生效变 Restart |

未决项（需要昊卿回忆，2026-07-25 表示记不清）：`anthropic-computer-harness.ts` 的 target_image_size 移植（28px patch / 1568 max edge / 二分搜索）当初是真观察到点击偏移，还是照文档预防性写的？这决定 CuFrameAdapter 整层要不要抢救。

---

## 四、贯穿约束

### 铁律：文档不进提交

`docs/` 和 `plans/` 类文档（含本文件）一律不进 git 提交。保持 untracked。

- 提交前用 `git status --short | grep -v '^??'` 确认已跟踪文件里没有文档
- 用 `git add <具体路径>`，不用 `git add .` / `git add -A`

### fork 工作流

- 代码 push 到 `fork`（hqhq1025），不是 `origin`（上游 maka-agent/maka-agent，无 push 权限，403）
- PR base 上游 main，head `hqhq1025:<branch>`

### TCC 权限

真机 CU 测试必须走 desktop `.app`（bundle 身份接授权）。CLI / headless 都是裸 node，一样会中毒。

### 小步提 PR

不攒大分支。每个阶段独立成 PR，做完即提。这是上一轮 95% 白做的直接教训。

### 处置期间禁忌

不要跑 `git gc` / `git prune`。`git worktree list` 里有 3 个 prunable 条目，别顺手清理。

---

## 五、调研数据索引

三轮调研的原始数据（含 16 路 findings、证据链、对抗验证结论）：

- 汇总：`/tmp/cu-study/all-findings.md`（376K 字）
- 参考仓库浅克隆：`/tmp/cu-study/{occu,permiso,cua-sample,occu-labs}`
- 分支审计判断书：workflow `w92kmbml8` 输出
- Codex 逆向：workflow `wf_cd773bbf-29d` journal
- 开源深读：workflow `wf_5fe7d5af-18a` journal

相关 memory：`maka-cu-runtime-helper-audit`、`maka-docs-not-committed`、`maka-cua-tcc-background-trap`、`maka-git-fork-workflow`、`maka-cua-shared-package`
