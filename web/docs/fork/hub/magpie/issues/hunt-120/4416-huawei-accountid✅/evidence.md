# #4416 判定证据（hunt-120 lane E，2026-11-03）

## 判定
缺陷属实但**已在 3b5dccd52（= tag v0.1.2247，yetone，2026-10-30）修复**；报告者 MYCF711 已在 0.1.2256 实测通过并说「可以关」。派单假设「v0.1.2247~2256 引入回归」方向相反：报告者的版本对（0.1.2214 vs 0.1.2256）是修复验证，不是引入窗口定位。贡献形态 = 分析帖（非 patch）。

## 代码核实（tip db7c57670）
- 显示优先级链完整：`internal/provider/account_names.go:135` `AccountShownOf = cmp.Or(AccountLabelOf, user)`；`:141` `AccountLabelOf = cmp.Or(AccountNameOf, PluginUserOf)`；`:163` `PluginUserOf`（本 run 内存读，else quotas.json；注释引 #4416）。
- 回归测试 `TestPluginAccountShownByItsUsageUser`（internal/provider/account_plugin_user_test.go）在 tip 通过：`go test ./internal/provider/ -run TestPluginAccountShownByItsUsageUser -count=1` → ok 1.690s。
- GUI 测试存在：internal/gui/tests/account-plugin-user.test.cjs。
- 报告者对 quota_last.go:81-83 的读法逐字成立：`if w.matches != nil { return q // a pool that can't be written down isn't kept` —— model-pool 窗口不落盘是**有意设计**（commit message「Not tried」段 + 维护者 issue 评论均明示），非回归。

## 交付
- take: issuecomment-6590579406
- 分析帖: issuecomment-6590584449（--body-file 发布，GET 回读一致；仅 GitHub API 附加末尾空行）
- Watched 三查 / 消融 / 完整矩阵：N/A（零代码改动；定向测试即全部所需证据）
- worktree /tmp/mg120-e 已 remove；分支 fix/4416-huawei-accountid-/tmp/mg120-e（早前中断调用所建）与误建的悬空分支 fix/4416-huawei-accountid 均已删除
