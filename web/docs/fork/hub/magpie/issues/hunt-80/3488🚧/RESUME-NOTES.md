# H11 #3488 RESUME NOTES — 已发布，本单完结

## 交付
- 评论已发：https://github.com/yetone/magpie/issues/3488#issuecomment-6390224229（id 6390224229，user ggbdpq，2026-10-24T22:17:08Z）
- fork 分支：ggbdpq/magpie `hunt80-f-3488` @ `988abf6ed2cc0b8a624fc1bf46308d2aa9d90354`（已 rebase 到 upstream/main 611b9e17，force-with-lease 推送，ls-remote 比对一致）
- patch：本目录 `0001-3488.patch`（rebased 后重生成），sha256 前 16 = `dbabb9b6bb748595`，正文嵌帖
- commit 尾注 GLM-5.3-Flash 计数=1，无需 amend

## 修法形状（前车道 H6，本轮复核成立）
- 机理：测试在 open session 动画结束后单次读 tile 矩形；card 尺寸类 max520（map 3.1:1→2:1）由 cardSizes 观察者的 rAF 推迟落地，翻转变晚则 map 的 ResizeObserver 二次布局，kept tile .62s 滑动中段被读到 → "two tiles overlap"。
- 修复：读矩形前等稳定——100ms 间隔连读，三连相同（same<2、60 试，与上方 wheelTo 惯法同构）才断言；真重叠的稳定布局仍会红，永不稳定的最后一读仍红。
- 与 yetone 新数据吻合：ja 420px 全包红 + zh-TW 420px 裸跑 1/2 红（"not load only / not language-specific"）= 断言与布局竞态固有，负载只改谁赢；patch 不钉翻转，只拒读未稳态。

## H11 复核证据（playwright 1.57.0 = ~/.npm/_npx/e41f203b7505f1fb）
- rebase 后双引擎全 spec：`h11-dual1.log` 22/22（chromium+webkit）
- 消融：checkout HEAD~1 的 context-map.test.cjs + inject-v9.py 注入 → `h11-ablate-red.log` de 420px 红 "two tiles overlap"（10/11，与前车道 v9-red 8/8 同字样）→ 恢复分支文件 → `h11-restore-green.log` 22/22
- 前车道日志沿用：base-r1/2/3（裸跑 3×11/11）、v9-full1+v9-red（注入红 1/1+8/8）、fix-green（注入修复后 8×11/11）、fix-bare1、final10（裸跑双引擎 5×22/22，第 6 轮起因交接截断）
- 零重叠：7b1faf99..611b9e17 无任何 context 文件触及；patch 只动 internal/gui/tests/context-map.test.cjs（16+/5-）

## 发布链
- 查重：末条仍 yetone 6388651219 → 发帖 → GET 回读八项 grep 全过（分支链接/Attribution/GLM=1/零中文/围栏 2 配对/无裸尾注/format-patch 嵌入/无 AI use 段）；body 与本地文件逐字一致（仅尾随换行被 GitHub 剥离）

## 状态
- 已成交付已发布，无遗留。worktree 已清（本目录仅存本笔记、patch、日志）。主线程记账即可。
