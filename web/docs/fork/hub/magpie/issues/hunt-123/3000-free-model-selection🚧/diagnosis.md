# #3000 Our Free Model 选中的模型会莫名消失，且会自动选免费 — 诊断记录

- 报告者：Sun1090（2026-10-20 02:48），take 评论 6639346453（ggbdpq，2026-11-04）
- worktree：/private/tmp/mg123-at，分支 fix/3000-free-model-selection，基 upstream/main f24829636af07d270ae902d132dbe5f76563629f（2026-11-05 fetch 核实仍为 tip）
- 判定：**b) 设计行为 + 已修复的历史缺陷**（免费插件目录刷新本会换选中；报告者所见是 v0.1.1167–v0.1.1293 的已知缺陷，issue 发出前一天刚落自愈修复）→ 发英文判定帖，不发 patch。

## 截图解读

- 评论图（"正常是选择了这些"）：picks 大量勾选（deepseek-v4-flash、glm-5.3-flash、MiniMax/DeepSeek/Spark 池等 ~13 个）。
- 正文图 1（故障态）：供应商列表 tab，72 个模型，全部虚线框（served-not-picked 的 `auto` chip），无一勾选 —— 即 `draft.chosen` 为空、无 picks 状态下 `dashed()` 前 24 被当作 served 展示（app.js:11100）。
- 正文图 2（仅所选 tab）：picks = 3 个 Kilo 免费/试用池模型（Kilo North Mini Code、Kilo Nemotron 3.5 Content Safety、Kilo Nemotron 3 Ultra）+ 顶部被裁切的 chip——与正常态 picks 完全不同，判断为故障后用户手工重选或列表轮换后的残余状态。

## 机理（代码证据）

1. Our Free Model 是插件 provider（magpie-our-free-model，`plugin.Provider{ID:"our-free-model"}`），模型目录由插件 models hook 提供，池（pool/channel）频繁上下线。
2. 网关侧 magpie 每小时 relist 插件目录（`internal/provider/plugin_relist.go`：relistFirst=1m、relistEvery=1h、有 pick 掉榜时 relistSoon=5m）。
3. 掉榜 pick 被 `dropGonePicks`（internal/provider/models.go:360）移出 Models 存入 Delisted（"选中的模型消失"）；列表恢复后 `relistPicks`（models.go:402）自动放回。
4. 全部 pick 被搁置时 `waitsForPicks`（models.go:1574）在 pickWait=1h 内什么都不 serve；超时后 `Exposed`（models.go:1594）serve 整个供应商列表的前 24 个（`manyModels`）——Our Free Model 的列表头部全是免费池（截图 1 顶部即 Beam Free、MiMo…）→ agents 侧看到的全是免费模型（"自动选免费"）。编辑器中这批模型画成虚线 `auto` chip（app.js:11244），看起来像"被自动勾选"。
5. GUI `Chosen` 来自 `p.PicksOf(avail)`（internal/gui/providers.go:704），Models 空时为空数组 → 编辑器显示"无勾选"（截图 1）；UI 无任何"picks 已搁置待恢复"的提示（rg 全查仅代码注释提及，drawLost 是 routing groups 的提示，与此无关）。
6. 排除的假设：
   - AutoInclude/takeMatching（autolist.go）自动加选：`ownList()` 为 false（插件 provider 被 `errNotOwnList` 挡住），`RefetchTaking`/`refreshDueLists` 均不触及插件 provider。排除。
   - `withNewlyListed`（models.go:1772）自动加新上榜模型：仅当 picks 覆盖当时全部在列模型（PickedFrom 判定）才加；13/72 的部分勾选必被"one the user saw and left unpicked"分支挡回。排除。
   - 编辑器 Save 清 wait：payload 不带 delisted/delistedAt（app.js:9487 body），但 Save 内 `p.Delisted = delistedWith(p, was)` 先行，`delistedAtWith` 随后读到非空 Delisted → `was.DelistedAt` 保留（provider.go:1131-1133）。TestEveryPickDelistedServesNone 覆盖。排除。

## 版本时间线（git tag --contains 实测）

| 版本 | 日期 | 行为 |
| --- | --- | --- |
| ≤ v0.1.1166 | — | 无自动 relist：picks 保留但池下线后请求报错 |
| v0.1.1167（88519703c，10-10） | Jeremy.Zhou 案 | 每小时 relist；掉榜 pick **永久移除**；`Exposed` 无守卫 → picks 被清空后**立即** serve 整个免费头部列表 —— 报告者的症状（issue 发于 10-20，此窗口内） |
| v0.1.1294（8febe3a50，10-19，issue 前一天） | 多喝热水案 | 掉榜 pick 改为 Delisted 搁置，等待期不 serve，列表恢复自动放回 |
| v0.1.2768（7c115f6f5，11-03） | maxleebeta 案 | 搁置超 1h 后才回退 serve 整列表（pickWait） |
| 最新 v0.1.2993（2026-11-04） | — | 上述全部包含 |

## 消融验证

本单无 patch（判定帖），消融不适用；机理以现有 4 个针对性测试锁定：TestPluginPicksComeBackWithTheirList、TestEveryPickDelistedServesNone、TestPicksGoneForGoodServeTheList、TestListedAsPickLeavesWithItsModel（internal/provider/plugin_delisted_test.go）。

## 遗留观察（未改，属产品决策）

编辑器在 picks 搁置等待期显示"无勾选 + 前 24 虚线"，与"用户清空了 picks"不可区分——若维护者愿意，可在 `why` hint 或 provider 行加一句"picks set aside, back when the list has them"。判定帖中提及，供维护者参考。

## 发布

- 判定帖已发：https://github.com/yetone/magpie/issues/3000#issuecomment-6639680857（作者 ggbdpq，2026-11-04T19:12:29Z）
- 帖副本：comment.md（本目录），sha256 前 16：db60aaaea4bd08cf
- GET 回读核：body 2905 字符，Attribution（written by AI (GLM via ZCode) as ggbdpq）、全 SHA（f24829636af07d270ae902d132dbe5f76563629f）、credit @Sun1090、v0.1.1294/v0.1.2768 版本号、零中文——全部在帖。
