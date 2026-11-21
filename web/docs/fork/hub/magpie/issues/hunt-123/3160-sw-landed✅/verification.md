# hunt-123 / issue #3160 — 已 landed 判定帖核验记录

日期：2026-11-05
形态：判定帖（零代码），不关单
评论链接：https://github.com/yetone/magpie/issues/3160#issuecomment-6638096577
本地产物：`post.md`（判定帖副本，与已发评论逐字一致）

## 时间线

- 2026-10-21 yiliang114 开 issue：托盘「额度」页骨架屏，建议 stale-while-revalidate（附源码定位，本地 dc08da83）
- 2026-10-25 yetone 评论（id 6396547958）：v0.1.1528 已按建议修复（09c0a844b），WebKit 723ms→211ms，先保持 open 等报告者确认
- 2026-11-04 ggbdpq take（id 6638060181）
- 2026-11-05 本判定帖发出（id 6638096577）

## 独立复核（不抄维护者话，本机 magpie clone 实测）

1. IN-MAIN：`git merge-base --is-ancestor 09c0a844b upstream/main` → 通过；main tip `f24829636af07d270ae902d132dbe5f76563629f`
2. Diff 面（`git show 09c0a844b --stat`）：
   - `internal/gui/assets/app.js` +31/-（storage 读写 + panelQuotasNow 并行请求）
   - `internal/gui/assets/app.css` +11/-（quota-refresh 旋转样式）
   - `internal/gui/core_budget_test.go` +4/-（预算数字随新 size）
   - `internal/gui/tests/panel-quota-kept.test.cjs` 新增 +88（消融回红：旧 assets 红 TimeoutError、手工去掉 early ask 红）
3. 符号在 tip 存活（rg 实测）：
   - `magpie.panelQuotas`：app.js:15559（kept 读取）、15609（localStorage 写入）
   - `panelQuotasNow`：app.js:4274/4294/4346（首载并行请求）
   - `.quota-refresh.reading/.busy/.spun`：app.css:1133-1147（转圈指示）
4. 版本对照：`git tag --contains 09c0a844b | grep '^v0.1' | sort -V` 最小 = **v0.1.1528**，与维护者说法吻合（无需推算）

## 发布后 GET 回读核验（comments/6638096577）

| 核验项 | 结果 |
| --- | --- |
| user = ggbdpq | PASS |
| 点名 @yiliang114 | PASS |
| 点名 @yetone | PASS |
| commit 09c0a844b 在帖 | PASS |
| tag v0.1.1528 在帖 | PASS |
| main tip f24829636 在帖 | PASS |
| Verdict 开头钉死 | PASS |
| 零中文（CJK 扫描） | PASS |

## 后续

- 不关单：维护者留 open 等报告者确认；确认义务在 yiliang114（升级 v0.1.1528+ 复测回帖即可关闭）
- 维护者自报未测面：真实托盘图标端到端 / Codex/Claude 订阅账号 / Windows、Linux webview
- 本单无代码动作，无台账代码账；记账进 journal 由主线程收口
