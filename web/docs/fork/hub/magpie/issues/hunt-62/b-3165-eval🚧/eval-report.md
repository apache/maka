# hunt62 Lane B — #3165 realfirst 补丁对照评估（2026-10-22）

## 判定：(a) 互补不覆盖 → 补充帖形态

realfirst 的 `fix/chat-fold-reasoning-aliases`（84c2b3a8）与我方 `hunt58-f-3165-reasoning-dup`（130b761b）**互补，互不覆盖，叠加零冲突**，符合 #2855 先例判据。

**发帖状态纠偏**：简报只列了我方两条评论（6320485575 / 6327619924），但姊妹车道今天 20:49–20:53 已完成同题评估并发帖——**评论 6341205131**（原文即 `docs/issues/hunt62/3165-realfirst-fold/reply-comment.md`），内容已含：验证对方分支、互补声明、stacking 干净、共同缺口（非工具消息 `reasoning_content`+`reasoning_details`）。其结论与本车道独立实测一致。

因此本车道草稿（`comment-draft.md`）是**补充帖**：只发姊妹车道帖没有的探针级新事实，是否发出由协调者定（重复发全量对照帖会自我重复）。

## 对象核对

| 项 | 值 |
| --- | --- |
| realfirst | `fetch https://github.com/realfirst/magpie.git fix/chat-fold-reasoning-aliases` → 84c2b3a8，单 commit，merge-base 8a99473e（较老主干，但其 chattidy blob `68432016` 与当前主干 87d703c5 相同），diff 与 issue 内联 patch 逐字一致（3 文件 +54/−8） |
| 我方 | `origin/hunt58-f-3165-reasoning-dup` @ 130b761b（父 f5b01574，3 文件 +75/−11） |
| 基线漂移 | f5b01574..87d703c5 的 chattidy.go 漂移全在 chatTidy/chatWhole 流式 finish_reason 区（47–345 行），未触 `withReasoningOnToolTurns`（387+）与 fold 插入点（~451）；gateway.go 漂移在 models/countTokens 区，未触 passthrough 分支 |
| cherry-pick | 84c2b3a8 → 干净；130b761b → 干净（单独与叠加均无冲突，测试文件同行同改被 merge 机器平凡消解） |

## 逐面对照矩阵（探针实测）

面的清单按 #3165 原报告的别名场景展开；"400 触发"指 issue 引擎/jD Cloud relay 已证的双拼写拒绝形。探针为临时测试 `TestZZProbeFacetBodies`（5 个请求场景，记录上游实际收到的 assistant 消息 JSON），已在四个状态下运行后删除。

| 面 | S0 基线 | S1 theirs 单独 | S2 ours 单独 | S12 叠加 | 判定 |
| --- | --- | --- | --- | --- | --- |
| F1 工具轮回显 `reasoning`（注入后双拼写） | 双字段（400 触发） | ✅ 单字段（注入拷贝+fold 删） | ✅ 单字段（注入内搬走） | ✅ | **两方都盖**（机制不同：注入内 vs 后置 fold） |
| F2 工具轮回显 `reasoning_details` | details+rc | ⚠️ **details 残留**+rc（fold 只认 `reasoning`） | ✅ 单字段（`messageReasoning[1:]` 连 details 一起删） | ✅ | **仅我方盖**（残留是否 400 取决于 serde，未验证） |
| F3 工具轮自带 `reasoning_content`+回显 `reasoning`（early-return 面） | 双字段（400 触发） | ✅（fold 删） | ✅（早退分支删） | ✅ | **两方都盖** |
| F4 非工具消息双拼写（无工具调用请求） | 双字段原样转发（400 触发） | ✅ 单字段（fold 全消息扫） | ❌ **原样转发**（注入不触达非工具消息） | ✅ | **仅对方盖**（对方新测试 `TestChatBothReasoningSpellingsRelayed` 锁定） |
| F5 非工具消息 `reasoning_content`+`reasoning_details`（无 `reasoning`） | 原样 | 原样 | 原样 | 原样 | **共同缺口**（与 6341205131 所记一致；serde 是否把 details 读进同字段未验证） |

## 探针证据摘要

工作区：/tmp/magpie-r62-b（分支 hunt62-b-3165-realfirst-eval，基线 87d703c5）。实验后已 `reset --hard 87d703c5` + 删探针文件，`status` clean；主 clone 未动（fetch 在 worktree 做，仅入共享对象库）。

1. **S0 基线**：F1/F3/F4 上游收到双拼写；F2/F5 收到 `*_details` 残留形。
2. **S1 = 87d703c5 + cherry-pick 84c2b3a8**（ecd6c585）：`go test -tags nogui ./internal/gateway -run Reasoning -count=1` 全绿（含对方新测试）；探针：F1/F3/F4 修复，F2 details 残留，F5 原样。
3. **S1+我方回归测试**（补 `deepseekAliasSerde`+`TestChatToolTurnReasoningCarriedOnce`）：**PASS** —— **theirs 单独已修复 issue 报告的全部观测故障**，我方测试对它不是必依赖。
4. **S12 叠加**（再 cherry-pick 130b761b → 319f882a，自动合并零冲突）：`-run Reasoning` ok（8.7s）；探针 F1–F4 全单字段，F5 仍原样。
5. **S2 = reset 后 87d703c5 + cherry-pick 130b761b 单独**（5c9389e4，75/11 全量干净）：我方测试 PASS；**对方测试 `TestChatBothReasoningSpellingsRelayed` FAIL（400 duplicate field `reasoning`）** —— 代码阅读层面的"我方不触达 F4"获红绿实证。

## 评论草稿要点（comment-draft.md，英文补充帖）

- 开头明确承接姊妹车道帖（"the comparison above"），只补两条探针事实；
- 事实一：**either-alone 充分**——对方分支单独过我方回归测试；我方 patch 单独挂对方新测试（F4 唯一我方够不到的面）→ 维护者取任一分支即可修掉 issue 报告的故障，取两个也干净叠加；
- 事实二：**details 不对称显性化**——仅对方 patch 时 F2 的 `reasoning_details` 仍随注入的 `reasoning_content` 转发（fold 只删 `reasoning`）；我方 patch 把 thinking 搬进 `reasoning_content` 并移除原字段；并如实标注 serde 对 details 的行为未验证（issue 的 A/B 表只示 `reasoning`/`reasoning_content`），属规范化余量而非已知故障；
- 形态纪律：普通对照类评论，**无尾部、无 Attribution**；涉及我方 patch 的表述保持事实准确；零中文。

## 不确定项

1. **aliasing serde 是否也拒 `reasoning_details` 同现**：未验证（无法触达 issue 引擎与 JD Cloud relay）。它决定 F2 残留在 theirs-alone 下是否有实际影响、以及 F5 共同缺口是否是真故障。两帖均如实标注未验证。
2. **草稿是否发出**：姊妹车道已发全量对照帖（6341205131）；本车道草稿为增量补充，发出与否（及是否等维护者表态再发）由协调者决定。
3. realfirst 开 PR 持续 404（账号侧），仅分支可拉——维护者取用路径只剩 `git fetch` 其 fork，评论里已点明。
4. F4 的实际触发形状（哪个客户端会在非工具消息上同时发两种拼写）无实测样本，属对方的防御性扩展面；不影响判定。

## 纪律核验

- worktree：`## hunt62-b-3165-realfirst-eval...upstream/main` @ 87d703c5，working tree clean，探针文件已删（`ls | grep zz_probe` = 0）。
- 主 clone：仍在 main，未切分支、未 stash、工作树未动；仅 worktree 侧 fetch。
- 未 push、未发帖；探针临时文件未留仓库。
