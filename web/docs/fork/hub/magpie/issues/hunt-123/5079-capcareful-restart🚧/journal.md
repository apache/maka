# hunt-122 / 5079-capcareful-restart — Lane D 作业日志

日期：2026-11-03。结局：**让位出列，分析帖计完成**（未 take，未产 patch）。

## 单
- Issue：yetone/magpie#5079（Claude CapCareful 重启后无法重读保存账号，持续本地 429）。
- 状态：OPEN，0 评论（发帖前），无 assignee。

## 让位闸判定
- **报告者自带修复（命中）**：uiuing 已推完整修复 `uiuing/magpie@19b1bd926`（分支 `fix/claude-careful-unread`），三测试 + Retry-After 缩短 + 真实验收，声明供维护者审阅/取用。共享规范 §1「报告者自带 patch 的单都不接」。
- 上游未 landed：`git log -S carefulDoubt` / `-S ReadUsageNow` 仅 08b02cf18（机制引入）。
- 无维护者表态；无方案先行撞车（报告者即方案方）。

## 独立核验（读 @1e1068c86，未跑报告者测试）
- carefulDoubt（cap_careful.go:44）挡 never-read/failed → readCareful（:73）→ ReadUsageNow（routing.go:810）→ StaleAllowance 清缓存 → claudeWindows（subscription_usage.go:819）只认 savedRefresh/spareRead/keep-alive，careful 的重读 ask 三者皆非 → 保存账号回传磁盘旧读数 → state()（login_usage.go:45）以 AsOf 判 failed → 每请求重复循环。链条与报告一致。
- 报告者 patch 面审查：readAsked ask 记录在通用 ReadUsageNow 写入、仅 claudeWindows 消费（通用入口无 Claude 分支）；仅无好读数（ws==nil && err==nil）或失败等待后接 ask；保留 30s 地板（claudeAskFloor）+ carefulRetry 节流；unreadBack 只缩短超 15s 的 Retry-After，保留更早 reset 与缺席头，含 spend-cap 混合分支。构造干净。

## 兄弟面
- #5085（miniersliu）：同根因链不同面——state() 把 kept/deferred 读数标 failed（分类面）；我方另一会话已交 patch（be674dccf，login_usage.go +11 -3 + GUI leftWhy 读 unread）。#5079=重读 ask 链（调度面）。语义面错开；仅 docs/subsystems/gateway-routing.md 双碰（各 1 行，平凡 rebase）。帖内已 disclose。
- carefulDoubt/readCareful/ReadUsageNow 全调用方：careful 家族自足（readCareful 是 ReadUsageNow 在 gateway 的唯一调用方；本单未改产品文件，无兄弟面改动需要列改/不改）。

## 交付
- 分析帖：https://github.com/yetone/magpie/issues/hunt-122 之 #5079 → issuecomment-6608274891
- 帖稿：post-yield-analysis.md（POST 一次 EOF 失败，GET 核实未发出后重试成功；回读逐字节一致）。
- 无 patch、无分支、无 push（让位单无产物面）。
