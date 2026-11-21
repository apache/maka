# hunt79-n-3473 笔记

## 占坑与基线
- take: https://github.com/yetone/magpie/issues/3473#issuecomment-6387314584
- 基线: upstream/main 3a47e377e0d67cc371fc7268172e5a4598fed922 (usage: a call whose vendor counts no cache...)
- worktree: /tmp/magpie-hunt79-n, 分支 hunt79-n-3473
- playwright 1.57.0: ~/.npm/_npx/e41f203b7505f1fb/node_modules

## Issue 事实（已读全文）
- 文件 internal/gui/tests/cli-update.test.cjs，chromium，子测试 "an update, the view left where it was"
- 报错: locator.textContent: Timeout 5000ms exceeded, waiting for '.row.agent[data-id="codex"] .ag-up'，stack cli-update.test.cjs:131:65
- 机制: L129 click → L130 waitForTimeout(150) → L131 读 .ag-up 期望 "Updating…"。负载下读的时候 fake 更新已完成、pill 消失（驱动定时器饥饿过冲 700ms fake 窗口）
- 维护者方向: "Wait on the busy state (or count the POST and hold the fake's answer) instead of 150ms"

## 源码核实
- app.js:2301 paintCLIButton: busy class 与 "Updating…" 文案同一同步 DOM 操作出现
- app.js:2339 updateCLI: click → cliBusy.add → paintCLIButton(busy) 同步 → POST（fake 服务端 L44 固定 700ms 延迟）
- 完成: finally → paintCLI 重画，update=false → pill 消失（L2282 条件）
- busy 窗口 = POST 延迟 700ms；固定 150ms sleep 是边沿对时序赌博

## 假设（负载下哪步没走完）
1. 主假设：Playwright driver（node 进程）在 --test-concurrency=3 + 系统负载 110-130 下饥饿，waitForTimeout(150) 的定时器过冲，等到 fake 更新（700ms）完成后才轮到 L131 读取 → pill 已消失 → 5s 超时。与 issue "the fake update has finished by then and the pill is gone" 一致。
2. 次要风险（不在本单范围）：L131-135 读链与 L137 force-click 都消费同一 700ms busy 窗口，极端负载下可能越过；但修法（busy 状态等待在窗口头几 ms 解析）比原修法窗口利用更优。

## 修法（最小、断言不软化）
L130 `await page.waitForTimeout(150);` → `await page.locator(`${row("codex")} .ag-up.busy`).waitFor();` + 注释。
等 busy 状态出现（边沿触发、页内 raf 轮询对 driver 饥饿稳健），断言 L131/132/135 原样保留。

## 注入设计（RED，不提交）
机制忠实：issue 机制 = 固定 sleep 结束时更新已完成。注入 = 缩 fake POST 延迟 700→100ms（测试文件 L44），固定 sleep 结束（≥150ms）时 pill 必然已消失 → 5s 超时红，字样同 issue。
GREEN 下注入保留：waitFor(busy) 在 ~35ms 解析，读链 ~50-80ms，busy 窗口 ~110ms，本机无载裕度 ~30-40ms（可实测调宽）。
消融 = 注入保留 + 修复 hunk 回退（=RED 状态重放）。

## 兄弟面（同 spec 固定 sleep 逐个判定）
- L105 waitForTimeout(300): ARTIFACT_DIR 截图块内，无断言依赖 → 不改
- L121 waitForTimeout(60): wheelTo 轮询循环节奏（循环条件本身查状态）→ 不改
- L123 waitForTimeout(300): 滚动落定等待，读 scrollTop（wheel 离散滚动非动画）→ 不改
- L130 waitForTimeout(150): 本单 → 改
- L138 waitForTimeout(900): 终态读（版本/pill/status，过冲免疫；窗口 700ms+200ms 余量）→ 本单不改
- L151 waitForTimeout(1000): 同上（失败路径终态）→ 不改
- L181 waitForTimeout(100): 视口变化落定，同步 reflow → 不改

## 交付（2026-10-25）
- commit: e9bb13ae478ad9bde3ef9a1f5dde2366e7678a92（ggbdpq 身份，1 file +5 −1）
- fork 分支: hunt79-n-3473（ls-remote 与本地一致）
- patch sha256 前 16: 2bcc8867d919c50a
- take: comment-6387314584；交付帖: comment-6387493267（GET 回读 7535 字符一致）
- RED（注入 700→100ms，未提交）: 双引擎 FAIL，`locator.textContent: Timeout 5000ms exceeded` / `waiting for locator('.row.agent[data-id="codex"] .ag-up')` / 131:65——与 issue 逐字同
- GREEN 注入下 3/3（30/30 点）；消融（回退修复 hunk 保留注入，diff 仅剩一行）RED 同字样
- 去注入 10 连跑 100/100（10 点×10，exit 全 0）
- 邻测: agent-update-all 18、agent-app-version 16、agent-connect 4，双引擎 38/38
- 上游漂移: 开工基线 3a47e377，发布时 0d2a1011，目标文件区间零触及
