# 老悬单复核轮 · 车道 A · #3525（2026-11-07）

## 结论：态a 已被上游吸收（ce8b67de3/#4470 类级替代）→ 判定帖（告别帖）已发+GET 回读过

- issue: https://github.com/yetone/magpie/issues/3525（open）
- 分支: `hunt95-a-3525-goto-class` @ `4482b60eb0df9853fde0a97fc8ae414df4ea4043`（远端未漂；留档不 rebase）
- 末帖（10-28 rebase 帖）: https://github.com/yetone/magpie/issues/3525#issuecomment-6469374736
- **本帖（2026-11-07 判定帖）**: https://github.com/yetone/magpie/issues/3525#issuecomment-6705352412
- 回读: author=ggbdpq ✓ 长度 1114 ✓ 围栏 n/a（无 patch 块）✓ 尾注 Generated-by ✓

## 吸收判定证据（排雷）

1. 上游 **ce8b67de3**（2026-10-31, "gui tests: a page's first load gets a minute, not a click's 5s (#4470)"）在 upstream/main 中（merge-base --is-ancestor ✓）；#4470=issue CLOSED，yetone 末评："Fixed in ce8b67de3 … tagged v0.1.2260. Every page in the GUI tests that sets a short default timeout now sets setDefaultNavigationTimeout(60000) on the same page (988 files) … nav-timeout.test.cjs fails if a file brings the pattern back"。
2. tip 实证: `provider-save-busy.test.cjs:62-63` 与 `privacy-hides-accounts.test.cjs:58-59` 均有 `setDefaultTimeout(5000)` + `setDefaultNavigationTimeout(60000)`（正是本单两支接线文件）——类面被上游以更大预算（60s vs 我方 15s）+守卫测试覆盖。
3. 我方支（reader.cjs boot() helper 15s + 两文件接线，3 文件 +17/−1）对 tip `git am` **三文件全不适用**（privacy-hides:56 / provider-save-busy:60 / reader.cjs:202 context 全漂移）——物理性被取代。
4. 语义对照: boot() 形态（helper 内 setDefaultNavigationTimeout）不满足新守卫 nav-timeout.test.cjs 的字面扫描（`X.setDefaultNavigationTimeout(...)` 正则），上游内联形态是幸存形态。
5. 单号 grep 其余命中（a41d0d509/ea7c0067e）均为正文交叉引用非吸收；open PR 无；收编形态末评无（但 issue 证据链充分，判态a）。

## 互查留痕（任务书要求）

- `ls /private/tmp | grep mg-35`（17:07）: 空（车道 B #3524 尚未开工，无竞速面）。
- #3523 同域对照: 2bde65759 吸收（见 3523 NOTES）；两单 reader.cjs blob 同源（hunt112 台账在案）。

## 判定帖措辞要点（已发）

版本对照（boot() 15s vs 上游 60000 sweep，v0.1.2260）+ 升级指引（两文件行号+守卫测试）+ 关单建议（close as fixed on main by #4470）+ Attribution + 尾注。零中文 ✓。

## 遗留事实（上报主线，非本单行动）

nav-timeout.test.cjs 守卫在裸 tip（191f3c0af）**本身红**（0/1）：5 个 10-31 后新增文件缺 nav 行（accounts-own-signin / accounts-switch-alone / agent-details-ready(8000) / icon-one-tone / provider-retrieval-only）——上游守卫正在失守，候选池素材。
