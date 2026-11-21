# hunt63 Lane D：#2988 澄清回帖核验笔记（2026-10-22）

对象：yetone/magpie#2988（gui tests: agent-update-all expects step 1 of 3 after a fixed 200ms wait）。
本车道只做核验+定稿，未 push、未发帖、未评论。

## 1. 前轮材料复核（hunt62/e-flaky/verification.md #2988 节）

- 判定 b：维护者通报的两形状 `1 !== 0`（gemini busy 断言，assert.equal(count, 0) 实得 1）与 `0 !== 1`（codex busy 断言 "the row's pill is busy in its turn"，实得 0）都在固定 200/300ms 睡眠后的同一断言块 = 本单修的病（click-to-assert 跑赢状态窗口）。
- 我方 patch 111f9904（hunt49-e-updateall-wait，10-19 22:11 评论，waitForFunction 状态等待 + fake 时长 updateMs 旋钮 1500ms）未合入，所以红还在。
- 前轮已在 87d703c5 验证：cherry-pick 干净、双引擎 18/18 绿；本地 2× 核烧机（load ~20-30）不可复现通报的 550-640。

## 2. gh 读帖核对事实引用

- issue 正文（yetone 10-19 19:14Z，load ~330-490，fb101b0d5）：首报形状是 regex 不匹配 `/^Updating Codex… \(1 of 3\)$/` 实得 `Updating Gemini CLI… (2 of 3)`（:122），归因明确指向固定 waitForTimeout(200)。
- 我方 patch 帖（ggbdpq 10-19 22:11Z）：内容与 verification.md 底账一致（111f9904、18/18 三轮双引擎、AI/Attribution 尾注在 patch 帖里）。
- yetone "Seen again"（10-20 10:39Z，load ~550-640，alone）：dee5c9d75+4f044c24c 双引擎红 `agent-update-all.test.cjs:105 (1 !== 0)`；另一未推批次 webkit 红 "the row's pill is busy in its turn"（`0 !== 1`）、chromium 绿。→ 草稿引用的两形状与原文逐字吻合。
- 帖内无其他新评论，无维护者对我方 patch 的否证。

## 3. 新基线轻量复验（一次）

- 基线：ba1dc7f9 = upstream/main tip（`git branch -r --contains` 确认；origin/main ebf3f48f 是旧 fork 头）。87d703c5→ba1dc7f9 增量 6 提交，agent-update-all.test.cjs **零改动**（diff --stat 为空）；gui tests 新增的是 qoder-checkin/routing/usage 等其他文件。
- worktree /tmp/magpie-r63-d（detached @ba1dc7f9）：cherry-pick 111f9904 → 干净落上（7ce4905b，仅 agent-update-all.test.cjs 4+/4-）。
- 运行：`NODE_PATH=/tmp/pw157/node_modules node --test internal/gui/tests/agent-update-all.test.cjs`（playwright 1.57.0 缓存 /tmp/pw157 仍在，沿用前轮 runner 方式，无需重建）。
- 结果：**18/18 全绿**（chromium 19.9s + webkit 20.5s，总 40.6s），0 fail / 0 cancelled。日志：本目录 `2988-patched-ba1dc7f9.log`。
- 负载读数：本轮空载跑（load ~3-5，12 核）；通报为 load ~550-640，本地够不着，回帖如实标注"by signature, not by run"（上轮 2× 核烧机也只到 ~20-30，草稿沿用该数）。
- 还原：`reset --hard ba1dc7f9`，status 干净，cherry-pick 已丢弃。

## 4. 定稿要点（2988-reply.body.md）

1. 两形状都落在固定 200/300ms 睡眠后的同一 busy 断言块 = 本单修的面（附和 + 签名分流）。
2. patch 在最新 main（ba1dc7f9）`git am` 干净、双引擎 18/18 绿（本轮实跑）。
3. 负载不可复现如实说明（12 核烧到 ~20-30 vs 通报 ~550-640）。
4. 欢迎维护者按 patch 帖原文取用。
- 普通确认类：无尾部、无 Attribution、零中文。

## 5. 发帖建议

**可发。** 事实引用已逐条对过原帖；验证是本轮在最新 upstream tip 实跑的新鲜结果；负载差距已如实披露。发帖动作留给主线程。
