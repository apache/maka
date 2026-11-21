# 老悬单复核轮 · 车道 A · #3523（2026-11-07）

## 结论：态a（已被上游 2bde65759 吸收）且 10-31 告别帖已在位 → 本轮零动作（不发帖不推分支）

- issue: https://github.com/yetone/magpie/issues/3523（open）
- 分支: `hunt81-b-3523` @ `077b78c12eacf309b0c0a2cfe7fd87a5f4b03e84`（远端未漂；10-31 已宣布 retired，留档）
- 交付帖（10-24）: https://github.com/yetone/magpie/issues/3523#issuecomment-6390827402
- **告别/退役帖（10-31，末评=我方）**: https://github.com/yetone/magpie/issues/3523#issuecomment-6545066563（"Retiring this branch: 2bde65759 (10-26) fixed the same flake on main another way … nothing to rebase."）
- 其后零回合（updated=10-31T15:00Z=该帖自身 bump）✓

## 吸收复核（本轮再证）

1. `git merge-base --is-ancestor 2bde65759 upstream/main` → YES ✓（"gui test: a gateway key's narrow check waits for the header to fit"，2026-10-26）。
2. tip 文件实证: `gateway-key-limit.test.cjs:123-124` `page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth, null, { timeout: 3000 })` + assert.fail 带宽度——上游等好态再断言，覆盖我方 settled-read 语义（我方修法=读前等 settle；上游=直接 waitForFunction 好态）。冗余确认 ✓（10-26 RB-B 台账同结论）。
3. 单号 grep 其余命中（333e7f573/96115018c）均正文交叉引用非吸收；ce8b67de3 在同文件 +1 行（nav 行，另一面）；open PR 无。

## 互查留痕（任务书要求，与 #3525 同域）

- `ls /private/tmp | grep mg-35`（17:07）: 空（车道 B #3524 未开工）。

## 四态出口：零动作

态a 判定帖的功能（版本对照+升级指引+关单建议）已由 10-31 退役帖承载（"2bde65759 fixed the same flake on main another way … the settle-read this patch added is redundant … stays up as a record; nothing to rebase"）；其后无新证据、无新回合。再发帖=重复噪音。本轮仅落档复核证据。
