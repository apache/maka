# #4923 车道 E 判定笔记（2026-11-02）

## 结论：分析帖（非 patch），已发布

- take: https://github.com/yetone/magpie/issues/4923#issuecomment-6579677567
- 分析帖: https://github.com/yetone/magpie/issues/4923#issuecomment-6579726910（14:31 UTC，GET 回读核实）
- 分支 fix/4923-pace-expiry-order 无提交（分析帖路线，零代码改动），已随 worktree 清理。

## 判定链

1. **issue 主诉已在基线修复**：v0.1.2736（95d0c97bf，2026-11-02 14:25 UTC 发布）=「Use before expiry」按每小时到期量排 pace（Allowance.Pace 折 Limit.RunsOut/RunsOutLeft）。issue 创建于 12:40 UTC，作者版本 ≤v0.1.2735 无此修复。探针实证 CodeArts 形态（插件 total 桶自带 runsOutAt，社区插件 0.2.0 起如此）：A=0.268 > B=0.149，先耗到期账号，多账号回落在插件数据刷新（soonestLapse left>0 过滤）后自然成立。
2. **issue 三处根因核对**：#2 已修；#1 被取代（到期折进 Seat.Pace 本身，gateway/routing.go:2085 接线，TestPaceGoesByCreditsExpiring 钉排序）；#3 对现插件不成立（total 桶非 aside 且带 runsOutAt，aside 只是明细）。
3. **残留真缺口 = OfficeAce 形态**：fetchOfficeAceUsage 把每桶到期时间放在各自窗口的 resetsAt（非 aside）；Allowance.Pace 跨预算窗口取 min（「the tightest」，#517 原始设计，TestAllowancePace 两条断言钉死「Opus by its own, the tighter」/「the general decides Opus too」，95d0c97bf 当日仍保留）。探针：fresh A=0.125 < B=0.139（被埋）；burned A=0（烧完桶 pace 归零+For 最满窗口→spent 层，即 #2878 根因家族）。Smart 用 renewals 会把该账号排最前（[20h, 720h]），Pace 是唯一埋它的策略——但改 min→max 会打破钉死的 Opus/general 语义 → 设计拍板，降级分析帖。
4. **给出的路**：插件侧给 OfficeAce 主窗口盖 runsOutAt/runsOut（照抄 CodeArts 插件对 total 的做法）→ v0.1.2736+ 立即生效，零 magpie 改动；或 magpie 侧跨窗口折算（#3428 领域）。

## 证据文件

- `probe4923_test.go` — 探针源码（基线 a3768cdd1 上运行后已从 worktree 删除）
- `probe-output.txt` — 探针输出（CodeArts GREEN / OfficeAce 双症状 RED / Smart renewals 对照）
- `post-body.md` — 已发布分析帖正文

## 不自信项

- OfficeAce「签到积分次日过期」按 bonus_skus 桶 expiresAt 建模（插件源码读数），无真机账号验证插件实际下发数据。
- 用户实际插件/magpie 版本未知（issue 未附日志），「更新过 v0.1.2736 即解」是从时间线+插件 0.2.0 起带 runsOutAt 推断。
- #2878 的修复（skygunner 6efc6c1e）是否合入会影响 burned 桶 spent 层半边，发帖时 #2878 仍 open。
