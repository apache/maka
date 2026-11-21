# #4477 switch-only claude 切回丢 prompt cache — 碰撞确认帖（无 patch）

- issue: https://github.com/yetone/magpie/issues/4477（mydosu，2026-10-30，0 评论）
- 开工 upstream SHA: `c0477aa728bf`（2026-11-01）
- take: https://github.com/yetone/magpie/issues/4477#issuecomment-6558377239
- 回帖: https://github.com/yetone/magpie/issues/4477#issuecomment-6558414460（2026-11-01T13:12Z，GET 回读一致）

## 判定

**上游已修，不开 patch。** `41b5c0f19`（2026-11-01 05:15 +0800，yetone）"accounts: Claude Code stays on the account it moved to till that is spent too (hxy920830 on X)" 实现的正是 reporter 建议方案 1。维护者从 hxy920830 on X 的独立反馈修的，commit 未提 #4477，issue 无人回——本帖价值 = 把两者关联 + 给 reporter 升级路径。

## 证据链

1. reporter 引用的 0.1.2229 代码 `if first != nil && first.On && first.Lapsed == "" {` 无守卫；当前 main 多了 `&& returnsToFirst(agent)`（internal/provider/codex_switch.go:294）。
2. `git log -S returnsToFirst` 唯一命中 `41b5c0f19`。commit 正文自认修复前行为："NextLogin (#408) signed the agent back in to the first account as soon as it was under 90% again, under every routing … switch only went back as well"——即 reporter 场景。
3. 修复语义：sign-in alone spends 的域（claude 全部、codex switch-only）留在被切到的账号直到 spent；切回仅保留在用户明示域（routing In order / KeepLogin）。return 记录仍写但仅在明示域生效。
4. 测试 `TestSignInStaysOnTheAccountMovedTo`（switch_sticky_test.go，该 commit 新增）：claude / claude switch-only / codex switch-only stay；claude In order goes back。消融证据在 commit 正文（returnsToFirst 强制 true 三个 stay case 全红）。
5. `git tag --contains 41b5c0f19` 最小 tag `v0.1.2479`；reporter 版本 0.1.2229 早于修复。
6. 默认 Routing=""（非 Ordered）→ switch-only claude 默认配置 returnsToFirst=false。

## reporter 三条建议的落点

- 建议 1（switch-only 不切回）＝ landed。
- 建议 2（空闲检测）：默认域无切回可 gate，不再需要。
- 建议 3（noReturn 开关）：只对 In order/KeepLogin 有意义——那是用户明示语义，维护者拍板保留（"No user setting is overridden"）；覆盖明示设置属新功能。回帖给 reporter 留了口子：若在 In order 下仍想要不切回，可单独立案。

## 未做/不确定

- 未验证真实 Claude 账号双窗口（同 commit "Not tried"）；纯代码+测试链推断。
- reporter 实际 routing 未知；若在 In order 下，切回仍在（设计保留），回帖已覆盖此分支。
- #4443（同报告者兄弟单：limit hit 即切 vs 5 分钟检查）仍 OPEN 0 评论，与本单不同缺陷，未动。
