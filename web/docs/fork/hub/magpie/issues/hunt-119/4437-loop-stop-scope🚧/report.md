# hunt-119 G：#4437 停止循环的回复会直接停止 agent 工作

- **判定**：分析帖（不 patch）。检测为有意设计且带双重逃生门；报告者触发例（`write_stdin` 空 stdin ×8）落在设计边界上，修法（wait 形态白名单/改阈值）= 重新定义检测策略 = 设计拍板，留给维护者。
- **issue**：yetone/magpie#4437（loscoy，2026-10-30，正文即 magpie 防循环提示原文）
- **发布**：
  - take：`issuecomment-6583751249`
  - 分析帖：`issuecomment-6583779298`（GET 回读与草稿逐字节一致）
  - 草稿：本目录 `comment.md`（零中文已核）
- **机制证据**（基线 upstream/main `a3768cdd1`，均已实读）：
  - 检测实现 `internal/gateway/tool_loop.go`：`toolLoopRepeats=8`，按 turn 哈希「tool name + steadyArgs + resultSum（剔除 Wall time/Chunk ID/duration_seconds 噪音）」，最近 8 回合全同 → 第 9 个请求由 magpie 本地应答、不达模型。
  - 结果变化的 poll 明确豁免：`TestToolLoopLetsProgressBy`（200 轮 pollJob 放行）+ 文件头注释 "A turn that got a different result … is progress and starts the count again"。
  - 逃生门测试：`TestToolLoopShortOrOffGoesOn`（`NoLoopGuard=true` 40 轮放行）、notice 进对话重置计数（`TestToolLoopLetsProgressBy` 第二段）。
  - 起源提交 `de281760e`（audie on Discord：同一代码被读 308 次/半小时，537 credits 白烧）。
  - 同文件族另一检测 `internal/gateway/loop_guard.go` 是 reply 内 reasoning/text 循环，与本单无关。
- **关键推断**：write_stdin ×8 被触发的前提是其 result 亦全同（sum 含 result，结果不同即不命中）→ 8 秒无新输出；「合法等待 vs 卡死」从请求本身不可区分，这正是维护者选「结果移动=progress」单一客观信号的取舍点。
- **门禁记录**：POST 前 fetch（tip 未动 a3768cdd1）+ issue 评论仅我方 take + open PR/issue 关键词（4437/looping/same tool call）无撞坑。
- **不自信项**：帖中「write_stdin 是 agent 等待进程输出的调用」基于工具名与参数直读，未读本机 Codex 源码核验；`write_stdin` result 的实际形态（每次 yield 是增量还是全量）未验证——若为全量累积输出，8 次全同即 8 秒零新输出，推断仍成立。
- worktree 已 remove，分支已删，/tmp 已清。不写 journal（主线程统一记账）。
