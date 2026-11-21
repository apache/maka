# 老悬单复核轮 · 车道 A · #2686（2026-11-07）

## 结论：态d 零动作（复核干净+无新证据；定向绿受上游同文件新红阻断，证据在案）

- issue: https://github.com/yetone/magpie/issues/2686（open）
- 分支: `hunt99-a-2686-tray-flash` @ `080166a90d3dff1af70e146d278eb106a326c2e9`（远端未漂，与 10-27 交付帖一致）
- patch: test(gui): tray-cell-click parks the flash at 600 of 1200 (#2686)，单文件 internal/gui/tests/tray-cell-click.test.cjs +28/−8
- 交付帖（10-27, sha16 939114f0fa39a599）: https://github.com/yetone/magpie/issues/2686#issuecomment-6454570750（末评=我方，其后零回合）
- yetone 10-18 回合判定（任务书焦点）: comment 6256189091（2026-10-18T22:54Z）**早于我方 10-27 交付**，全文="Seen again at origin/main 1a3b92688 (machine load average ~500), webkit zh only, red 3 of 3 when run alone… I'm not taking it; this is evidence only."=交付前补充复现+evidence only，**非接手/非驳回信号**；我方交付帖已覆盖该面（注入 RED 同措辞→GREEN→消融回红）。10-18 日期复核属实。

## 排雷五查（2026-11-07，tip=191f3c0af）

1. 单号 grep: `git log upstream/main --grep=#2686` 仅 2ceff7370（10-19 window-back 读态一次，正文交叉引用；先于我方交付基 dc1cfe015，非吸收）。
2. 域词 -S: tray-cell-click.test.cjs 上游自 dc1cfe015 仅 ce8b67de3 一笔（+#4470 nav 行，不重叠我方 hunk）；`animationName === "flash"` 动画读面无上游触碰。
3. open PR: 无（--search 全态空）。
4. 末评: 我方 6454570750（10-27T21:54Z），其后零回合 ✓。
5. 收编形态: 无（无 Landed as/It is ggbdpq's/v0.1.xxxx 开头末评）。

## 验证（2026-11-07，playwright 1.57 npx 缓存，GOCACHE=/tmp/mg-A-gocache）

| 项 | 结果 |
| --- | --- |
| `git am` patch → 191f3c0af | 干净 ✓（/tmp/mg-A-patches/2686/） |
| webkit tray-cell-click @ tip+patch（17:00 首跑，load~16） | 0/2 红 @ :77 visible() 预检——**非 #2686 动画面**（修法行未被触达） |
| webkit tray-cell-click @ 裸 tip（后台复跑） | 0/2 红，同 :77 形状 + 一例 goto 60s 超时 |
| webkit tray-cell-click @ tip+patch（17:20 重试，load 6.3） | 0/2 红，:77 同像素级几何（target bottom 768 > view bottom 700，scroll 11/max 199 不动）=确定性非饥饿 |
| webkit tray-cell-click @ 裸交付基 dc1cfe015（今日同机同引擎） | **2/2 绿** ✓ |

### 判读

- 裸基绿 + 裸 tip 红 ⇒ **上游 dc1cfe015..191f3c0af（299 笔 app.js 提交）之间有提交把 tray-cell-click 在 main 上弄红**（open() 的 visible() 预检：聚焦卡片未滚入 .view；嫌疑线索=tray panel fits/height 族：c2b8814e7 "keeps the latest height it asked for, its fits sent one at a time"、5db1b07ed、5b9bfe407、7033f5072——未二分定位，留主线候选池）。
- 该红与本单修法（flash 动画驻停读取）无涉：修法行在红点之后，从未被执行到；am 干净、diff 内容未漂移。
- 定向绿在 tip 上**不可获得**（spec 在裸 main 即红）——按任务书"origin/main 同红不构成基线，照实列"；GUI NOT-RUNNABLE 之实质=被上游新红阻断，非引擎缺失。

## 四态出口：态d 零动作

- 复核干净（am 干净+远端未漂+issue open+我方末评在位）+ 无新证据（10-18 回合已由交付覆盖）⇒ 不发帖。
- 若主线决定追上游新红（tray-cell-click 全红面），建议另开新单，与本支解耦；本支 patch 继续有效、可独立 am。

## 本单新增面（上报主线，非本车道处理）

tray-cell-click.test.cjs 在裸 tip（191f3c0af）webkit 确定性 0/2 红（open() visible() 预检超时，几何不动）；dc1cfe015 裸基 2/2 绿。上游回归窗口 dc1cfe015..191f3c0af。
