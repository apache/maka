# #3890 已 landed 判定车道 — 证据记录

日期：2026-11-04　车道：judged（维护者已修，发判定帖，不发 patch）
Worktree：/private/tmp/mg123-g（分支 fix/3890-stream-limit-judged，tip 基线 = upstream/main e17b6cef）

## 结论

已修复并已发布。修法：host 128 stream window 占满时 plugin fetch 改为有界等待（`streamWait = 1 min`，可取消、host 死亡早退），不再立即 `errTooManyCalls` → 网关 502 重试放大。修复提交 f8cd964ae **实随 v0.1.1780 首发**（v0.1.1767 的 release job 失败从未发布——维护者自己更正的）。

## 实测证据

1. **take**：comment-6621428339（2026-11-04T03:06:41Z）
2. **评论全文**：`gh api repos/yetone/magpie/issues/3890/comments?per_page=100`
   - yetone 6448214048：修法描述（128 window 满时等待、1 分钟封顶、RPC reserve 不等待、64 MiB budget 不变）+ 192 流 Bun 网关测试证据（旧代码同测试 960 条 502）
   - yetone 6454948220：更正 v0.1.1767 未发布，修复随 v0.1.1780（当时 Latest）
3. **祖先判定**：`git merge-base --is-ancestor f8cd964ae upstream/main` → yes
4. **修复形状**：`git show f8cd964ae` — 新增 `streamWait = time.Minute`、`beginStream`（窗口等待）+ `admit`（共享注册）；测试 TestHostFetchWaitsForAStreamWindow、TestPluginStreamsPastTheBudgetWait（internal/gateway/plugin_stream_admit_test.go 新文件）
5. **tip 现状**（e17b6cef，rg 实测）：
   - internal/plugin/host.go:167-168 streamWindow=512<<10 / streamBudget=64<<20（streamLimit()=128，:213）
   - internal/plugin/host.go:182-188 streamWait=time.Minute
   - internal/plugin/host.go:1636-1652 beginStream；:1937 fetch 走 beginStream
   - internal/gateway/plugin_stream_admit_test.go、internal/plugin/host_test.go 测试均在 tip
6. **版本含 tag**：`git tag --contains f8cd964ae | grep ^v0.1` 首个 = **v0.1.1767**（tag 存在）；GitHub release v0.1.1767 = 404（未发布），v0.1.1780 = published 2026-10-27T21:59:39Z → 与维护者更正一致，首发发布版 = v0.1.1780
7. **鲜度**：`git fetch upstream main --tags`；`git log upstream/main --oneline --grep=3890` → f8cd964ae 本尊 + 7fd77a944（#3946 对该 192 流测试的 macOS dial 修正，非重开）；无新修复
8. **最新 release**：v0.1.2890（published 2026-11-04T02:37:18Z）
9. **报告者版本**：issue 正文自述 0.1.1711 / 0.1.1714 → 均早于 v0.1.1780

## 判定帖

- POST：https://github.com/yetone/magpie/issues/3890#issuecomment-6621459925
- GET 回读：user ggbdpq，created 2026-11-04T03:08:57Z，2982 字符，开头匹配
- 帖内含：修复结论 + v0.1.1767 未发布经过（转述维护者更正）+ tip 文件：行 + 版本对照（0.1.1711/1714 → ≥ v0.1.1780，latest v0.1.2890）+ 升级指引（192 批次路由记录应变为每请求一 try）+ credit @NightGlowww + Not verified（未复跑高并发）+ AI use（e17b6cef）
- 正文副本：judgment-post.md（同目录）

## 未验证项

- 未复跑 192 并发真实 vendor 场景（判定车道只做代码/提交/release 核对）；帖内已明示 Not verified。
