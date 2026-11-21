# hunt-123 / 4985-stream-disconnect — 结局记录

- Issue: yetone/magpie#4985（2026-11-03T02:18Z 开，0 评论，报告者 tonylaysg）
- 结局: **判定帖出列（让位闸=已 landed）**，未 take，未出 patch
- 帖: https://github.com/yetone/magpie/issues/4985#issuecomment-6612601491（GET 回读通过，2636 chars）

## 证据链
- 错误串属 `internal/gateway/unrouted.go` 的 `unroutedBodyMsg`（pre-routing hold，`unroutedMost = 2m`）。
- 帖中旧文案 "The client is sending its body slowly..." 由 `e2d7d1f54`（2026-10-31）引入、`df69ffe97` 移除 → 报告者跑的是修复前构建（tag 区间 v0.1.2255 起，fix 首入 v0.1.2809，当前 v0.1.2862）。
- #4775 修复五连均在本 worktree 基线 7785c4278 内：df69ffe97（32 KiB/s 上传 credit）、19d04425c（+8min cap + 溢出 clamp）、639a15c50（chunked 两次读之间算 arriving）、b4e388547（credit 不可储蓄 + 空 gzip/zstd 有界）、897e88d7e（timer 1s 节流）。维护者 yetone 已在 #4775 确认合入并保持开放等报告者确认。
- 数学验证：报告者 3.8 MB / 120s ≈ 32.4 KiB/s ≥ credit 率 32 KiB/s → earned ≈ 121.6s ≥ spent ≈ 120s → `unmaskedLocked` ≈ 0，2m 定时器不复位即放弃的情形在新代码下不触发，上传可完成。
- 时间线：#4985 开于 2026-11-03T02:18Z，修复 df69ffe97 落于同日 05:36Z（+3h18m）。

## 复用价值
- 2m0s 家族判定的定位路径：`rg 'still arriving|unrouted' internal/gateway/` → `unrouted.go`（unroutedMost / unroutedUploadRate / unroutedUploadGrace / unroutedBodyMsg / giveUp 408 分支）；tag --contains 定报告者构建区间。
