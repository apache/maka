# hunt79-m-3501 工作笔记

## 基线
- upstream/main = e57e785633a7976d9ad31771979a6ed5b2e8e99a（2026-10-25 00:59 +0800）
- issue 报的是 d7ad3f2a3；两基线间 usage/page.js 改动 = #3493 系列 archive panel（+48 行），不触及 tabs/.opt
- spec line 133 在 e57e7856 与 issue 报告逐字一致
- playwright 1.57.0: NODE_PATH=/Users/ggbdpq/.npm/_npx/e41f203b7505f1fb/node_modules
- 占坑 comment: 6387262167

## 机理（实测代码依据）
- `renderUsageTab()`（usage/page.js:2191）: `$("#usageTab").replaceChildren()` 后重建全部 `.opt`，`on` 类落在 `usageTab` 变量对应的那个
- `loadUsage()`（usage/page.js:69）每次调用开头无条件 `renderUsageTab()` → **任何一次 loadUsage 重入都会把页面现有的 .opt 全部移除重建**
- loadUsage 的重入路径：
  a. usage 插件 `open()`（client.js:132，页面打开）
  b. usage 插件 `refresh(again)`（client.js:136）：focus/visibilitychange 回来且 `usageDrawn()` 为假（还在 loading/skeleton）→ `loadUsage()` 全量重建
  c. loadBack（app.js:24513）→ `load(true)` → 插件 refresh；focus 监听在 app.js:24573
- Playwright locator.evaluate：注入脚本 poll 找到元素与调用用户回调之间至少隔 microtask 边界；页面 boot 的 fetch continuation（renderUsage / 二次 loadUsage）排微任务，恰在其间 replaceChildren → 回调拿到 detach 的元素 → `b.parentElement === null` → `Cannot read properties of null (reading 'firstElementChild')`
- 这解释「timing, not tree」：单跑连红 = boot 微任务恰好挤进缝隙；webkit 事件时序不同故稳绿

## 假设清单（修前）
1. 主假设：line 133 locator.evaluate 的元素在 poll→call 缝隙被 renderUsageTab replaceChildren 移除（上述机理）
2. 次假设：`.opt.on` 首次渲染前不存在，locator 等待期间页面重排（18e82adc side-nav 改动后 .nav-s 与 .opt 并存）——被主假设覆盖
3. 兄弟面：line 144 `tall()` 同为 locator.evaluate（读 `b.querySelector("i.in").style.height`）——同型风险，判定改/不改时逐个看

## 修法方向（不软化断言本意）
- 「focus 后 charts 和 Routing groups 保持」断言全保留
- 只动 line 133 的读取方式：page 级 evaluate 同 tick 查询+读取 + 不在场时轮询（等价原 locator 默认等待，5s 超时 assert）
- 断言语义保持：`.opt.on` 在场且非首个 → 点击首个 tab（回 Overview）；一直不在场 → assert 红（不静默放行）

## 进度
- [ ] 自然红捕获（chromium 连跑）
- [ ] 确定性注入 RED
- [ ] 修前提交
- [ ] GREEN（注入下 4/4 + 自然连跑 20+）
- [ ] 消融回红
- [ ] 兄弟面判定
- [ ] 矩阵 + 发布

## 完成记录（2026-10-25）
- commit: 675bfbd23bef638428f4e0fa412f3f5d4788167a（父 = 基线 e57e7856）
- take 评论: 6387262167；交付帖: 6387456192
- patch sha256 前 16: af7a9c14e0dc0fe3；git am 实测重放零 diff
- 注入定型史：克隆注入 v1（丢 onclick artifact → 修正为 c.onclick=b.onclick）；focus 注入（+100ms 首发，未命中缝隙，弃用）
- 交付矩阵：注入下基线 2/2 红 / 修复 2/2 绿 / 消融 2/2 红；无注入修复 chromium 40/40（20 轮）、webkit 4/4；相邻 panel-usage 4/4 + usage-refresh 4/4；兄弟面 5 类判定均不改
