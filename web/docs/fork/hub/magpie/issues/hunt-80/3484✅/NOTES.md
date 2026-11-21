# H4 / #3484 hunt notes

## 编制
- 基线: 7b1faf99f2a36732a836fd135a7a2f937b4ed3e9 (upstream/main, fetched)
- worktree: /tmp/magpie-hunt80-d, branch hunt80-d-3484
- take: https://github.com/yetone/magpie/issues/3484#issuecomment-6387623531
- playwright 1.57.0: /Users/ggbdpq/.npm/_npx/e41f203b7505f1fb/node_modules

## 链路（app.js 实测读取）
- `#movable .deprecation` 唯一生成点: `renderMovable()` app.js:6321，由 `renderProviders()` app.js:6065 调用（同帧，badge 与 notice 无先后窗口）
- boot 链: goto(load event, ~30 个资源走 route handler 逐个 fs.readFile+fulfill) → start.js → load() app.js:4042 → `await api("state")`(4069) → view=providers → `await loadProviders()`(4111) → loadProvidersNow: `api("providers")` → renderProviders → renderMovable → notice 可见
- /api/state → /api/providers 串行（loadProviders 在 state await 之后）
- 超时面: `page.setDefaultTimeout(5000)`(spec L70) 同时约束 goto 与所有 waitFor
- boot 链暴露面: goto L75/L117/L121 + waitFor L79(notice)/L118(notice)/L122(badge)；页内交互 waitFor L98/107/111/113/120 不跨整页 boot，保持 5s 快败
- 无更早稳定锚: notice 前最后一个状态是 /api/providers 响应，页面上无 ready 标志早于 renderProviders（`#view-providers.loading` 移除与 notice append 同帧）
- 结论: 修法只能落在显式放宽 boot 链等待预算（方向③），数据支撑靠探针+注入

## 待办
- [ ] 探针: webkit zh 单跑分段耗时分布 (goto / goto→notice) ×10
- [ ] 注入 RED: /api/providers 第 2 次起延迟 6s → 期望 118 行红同字样
- [ ] 修前 commit（注入版留档）→ 修 → 注入 GREEN → 去注入 10 连绿
- [ ] 消融回红 / 兄弟面 rg / 失败读取语义
- [ ] 矩阵 + patch 帖 + GET 回读

## 探针数据（webkit zh，本机无负载）
- 首次 goto（对齐 spec L75-79）×10: goto min/avg/max = 156/190/221ms; goto→notice = 34/38/44ms; 合计 190-265ms
- reload 路径（对齐 spec L117-118）×10: goto = 89/96/127ms; goto→notice = 19/21/23ms; 合计 108-150ms
- 结论: 单跑 5s 预算余量 >18 倍；#3484 的红只能来自整 suite 负载（load ~110-130）下 route fulfill 排队慢化 >19 倍。无法本机复现负载 → 确定性注入（维护者 issue 内指名 /api/providers 延迟）

## 注入 RED 原文（6s 延迟 /api/providers 第 2 次起；BROWSER=webkit probe 副本）
```
✖ webkit zh: deprecated built-in subscriptions are badged and explained (5774.406416ms)
  locator.waitFor: Timeout 5000ms exceeded.
  Call log:
    - waiting for locator('#movable .deprecation') to be visible
      at .../deprecated-subscriptions.probe.cjs:119:20
```
- 与 issue 字样一致（副本 119:20 = 原文件 118:20）。en 同样红。

## 第二雷（注入 GREEN 过程发现）
- waitFor 放宽后注入版红在 `assert.deepEqual(errors, [])`：pageerror 收到
  `/api/update` + `/api/whatsnew` "due to access control checks."，成对同毫秒
- 机制: web 模式 backAsNew 每秒轮询 /api/update（app.js:4296）；whatsNewOnce 在 load() 尾部（providers 回来后）发 /api/whatsnew。第三次 goto 作废页面 2 的 in-flight fetch，WebKit 对导航作废的 fetch 冒全局 pageerror（rejection 虽有 catch 也冒）
- 单跑页面 2 存活 <1s（轮询首 tick 未到、fetch 即刻完成）→ 从未咬人；真实慢环境（notice 等待 >1s）轮询必开转 → 只修 waitFor 会让红换到 errors 断言再来
- 处理: pageerror 收集过滤固定文案 "due to access control checks"（fixture 全同源全 mock，该文案只会来自被作废的 read；不软化"无页面 JS 错误"本意）

## 注入 GREEN 原文（6s 注入 + boot 15s + pageerror 过滤）
```
✔ webkit en: deprecated built-in subscriptions are badged and explained (13507.159209ms)
✔ webkit zh: deprecated built-in subscriptions are badged and explained (13641.894916ms)
ℹ pass 2  ℹ fail 0
✔ chromium en: ... (13431.295125ms) / ✔ chromium zh: ... (13491.365916ms) → pass 2 fail 0
```
- 注入版留档 commit: f75c4d36（发布前 reset 掉，分支单 commit 最终态）

## 消融回红（head fa7b958e 反向修复 + 6s 注入，BROWSER=webkit）
```
✖ webkit en: ... (5718.262542ms)  ✖ webkit zh: ... (5746.734458ms)  pass 0 fail 2
  locator.waitFor: Timeout 5000ms exceeded.
    - waiting for locator('#movable .deprecation') to be visible
```
- 与 issue 字样一致，修复被剥离即回红 → 修复有效

## 兄弟面清单（rg 全查 + 判定）
- 同 spec 页内 waitFor（不改，均不跨整页 boot，5s 快败意图保留）：L98 cursor tile / L107 more tile / L111 #view-plugins / L113 pm-card / L120 #movable hidden（点击后本地同步渲染）
- 其它 `#movable .deprecation` 消费方 spec（5 个，均实跑双引擎全绿）：deprecation-notice(8) plugin-movable-review(4) plugin-move-unserved(12) retired-move(4) plugin-move(8)
- 同构暴露判定：5 个相邻 spec 均为单次 goto + default 5s waitFor（无 reload，暴露面小，#3484 未报红）→ 记录不改（patch 附 issue 一单一 patch；模式无共享 helper，各 spec 独立 boot，无可一处修全部的根因点）
- 失败读取语义：N/A——无新增/变更文件读取路径；fixture fs.readFile + 404 fallback 原样保留

## 矩阵
- 目标 spec（去注入）: webkit en+zh ×10 连绿（20/20）；chromium en+zh ×10 连绿（20/20）；双引擎全组合 1× 4/4
- 注入 RED: webkit en+zh 双红同字样；注入 GREEN: 4 组合 4/4；消融回红: webkit 2/2 红同字样
- 相邻 5 spec 双引擎: 全绿（8+4+12+4+8）
- 预存红对照名单：无（本机全部实跑，无预存病涉及）

## 分支
- hunt80-d-3484 单 commit fa7b958e on 基线 7b1faf99，仅 internal/gui/tests/deprecated-subscriptions.test.cjs（19+/7-）

## 发布
- take: 6387623531; 交付帖: 6387803226 (GET 回读一致, body 7948B)
- fork 分支: hunt80-d-3484 = fa7b958e59ea6f4db0ede37bd7cc07e72b29bd81 (ls-remote 比对一致)
- patch sha256 前16: 3b21aec23ff89f32
- upstream 复查: 工作期间前进 7b1faf99→40a0b442 (cli 域, 零触及 gui/tests); patch 基线=开工实测基线 7b1faf99
