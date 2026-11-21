# 4995 usage-denied-words 交付日志（Lane E）

- 日期：2026-11-04
- Issue：yetone/magpie#4995（SCIYYDy：/usage 的 401/403 requests 统计行被 claudeUsageDenied 裸数字误判为鉴权失败，额度窗口整读丢弃）
- Worktree：/private/tmp/mg122-e（分支 fix/4995-usage-denied-words，基线 upstream/main d8b3749ef）
- Commit：0b7eed05ac49375ee2e411f3a9aac98e3da2a47c（已 push origin，ls-remote 核对一致）
- Patch：0001-claude-a-usage-count-of-401-or-403-is-a-count-not-a-.patch，SHA-256 前 16 = 3650f06f6c2f99c4
- Take 帖：https://github.com/yetone/magpie/issues/4995#issuecomment-6615982131
- 交付帖：https://github.com/yetone/magpie/issues/4995#issuecomment-6616144157（GET 回读八要素全验，作者 ggbdpq）
- 修法：claude_usage_cli.go 加 claudeUsageCounts（`^Last (?:24h|7d) · [0-9]+ requests? · [0-9]+ sessions?$` 整行锚定），denied 扫描口对整行统计行 continue；claudeUsageDenied 本体与 #4532 扫描顺序不动；下游 4 个消费点（quota_last.go / subscription_usage.go ×3 / codex_switch.go）消费错误串，解析口修复全链路受益，零改动。
- 测试：TestParseClaudeUsageCountsSayRequests（报告者复现文本 fixture）；消融红（基线+测试=同款报错）→恢复绿；真 401/403/authentication failed 守卫不回归。
- 矩阵：provider 全包 nogui ok（106s，EXIT=0）；定向 race ok；gofmt/vet 净；go build ./... ok（gui cgo 警告预存）。
- 排雷：issue 0 评论无认领、无竞争 open PR、git log -S 无 landing、报告者仅本地热修无占坑。
- 结局：完成（发布+回读+收尾），等维护者裁决。
