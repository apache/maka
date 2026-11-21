# hunt60 Lane A · issue #3193 验证日志

日期：2026-10-22。worktree：/tmp/magpie-r60-a，分支 hunt60-a-3193-balance-toggle，基线 b0d46ca7fea2e4f04f55e4c60b051a6c28f4b5bd，head 579942e679de66090299ba73f8c071a9f9bfb89c（author/committer 均 `ggbdpq <ggbdpq@gmail.com>`，已核验）。

## 前提核验

- issue 3193 全文（gh issue view）：报告者 pc418（にとり），0 评论，复现步骤含精确 JSON（`{"windows":[{"name":"daily","used":8.9}]}` + `balance.path=Daily: windows.0.used / 100%`），Expected "91.1% left" + 条形 91.1%，修法方向 `quotaLeft ? 100-percent : percent`。与侦察一致。
- percent 语义（app.js 数据流）：`internal/provider/balance.go:716 balanceShare`（path 以 % 结尾时 n*100）、`:724 balanceAmount`（文本 "8.9%"）、`BalancePart`（balance.go:598，JSON `{label,text,percent,error}`）→ `subscription_usage.go:116 BalanceParts` → app.js `balanceShown`（17819）。
- quotaLeft 兄弟面：
  - 存储：`internal/settings/settings.go:404 QuotaLeft bool`；前端全局 `app.js:13873`，settings 同步 18919-18922。
  - 读了它的：quotaFill 13876、quotaText 13881-82、quotaPace 13898、cap mark 13656、amount 13922、tiers 14006、菜单栏 dial 17165-66 与 title 17174、history 卡 18078/18082/18084、按钮文案若干（15410/16939/17177/20182）。
  - 没读它的（本单修的）：app.js:17002（panelBalances）与 17806（balanceRow）两处裸 `balanceMeter(p.percent)` + 两处 part 文本 `p.text` 直显。正是"订阅卡读了、余额卡没读"的形状。
- 测试基建：`internal/gui/tests/*.test.cjs`（Node test runner + Playwright + mock API），形态参考 quota-balance-error / routing-quota-left / panel-balance-order。CI（test.yml）不跑 browser 测试，按仓内惯例本地跑。

## 改动面（最小修复，4 处编辑 + 1 新测试）

- `balanceMeter`（app.js 17825）：fill 按 `quotaLeft ? 100-used : used`，`full` class 保持 keyed to used share。
- 新 `balanceText(p)`：percent 存在且 quotaLeft 时 `t("{n} left", {n})`（复用既有 i18n key，zh "剩余 {n}" 等 4 语言已在 i18n.js），否则原 `p.text`。
- panelBalances 三分支（17000-17002）与 balanceRow（17807）的 part 文本改走 `balanceText(p)`。
- Go 侧零改动（渲染层选择，与报告者方向一致；Balance/tooltip/history 保持回复原数）。

## TDD 原文摘录

RED（基线，先于修复）：

```
✖ chromium en: a balance part asked as a percent reads left (7367.341458ms)
  locator.textContent: Timeout 5000ms exceeded.
  Call log:
    - waiting for locator('.subscription-card').filter({ hasText: '91.1% left' }).locator('.bal-part').filter({ hasText: '91.1%' }).first().locator('b')
```

GREEN（修复后，全量 4 case）：

```
✔ chromium en: a balance part asked as a percent reads left (879.155041ms)
✔ chromium en: a balance part asked as a percent reads used (739.800125ms)
✔ chromium zh: a balance part asked as a percent reads left (786.491375ms)
✔ chromium zh: a balance part asked as a percent reads used (758.849708ms)
ℹ tests 4  ℹ pass 4  ℹ fail 0
```

消融（产品文件 `git checkout -- app.js` 回基线、测试保留）：

```
ℹ pass 0  ℹ fail 1
✖ chromium en: a balance part asked as a percent reads left (5500.258041ms)
  waiting for locator('.subscription-card').filter({ hasText: '91.1% left' }) ... TimeoutError
```

恢复修复后复绿（4/4）。

## 矩阵（退出码）

| 命令 | 结果 |
| --- | --- |
| `BROWSER=chromium node --test internal/gui/tests/balance-quota-left.test.cjs` | 4/4 绿 |
| 消融（基线）/恢复 | 红 / 绿（闭环） |
| 相邻回归 panel-balance-order + quota-balance-error + balance-parts + panel-usage | 22/22 绿 |
| 相邻回归 routing-quota-left + usage-quota-head + quota-pools | 8/8 绿 |
| `go test -tags nogui -count=1 ./internal/gui` | exit 1：仅 TestProxyCheckSaysAProxyPassedBy（任务预告的预存红，非本单改动面），其余 ok |
| `gofmt -l internal/gui internal/provider internal/settings` | 干净，exit 0 |
| `go vet ./...` | exit 0（trayimage_darwin.go cgo enum warning 为基线预存） |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `go build -tags nogui` darwin / linux/amd64 / windows/amd64 | 均 exit 0 |

## Watched 三查

1. 人为打破：消融即"打破"（产品回基线复红），已闭环。
2. 兄弟面：裸 percent meter 绑定恰两处（17002/17806），同修；文本与条形同修（issue Expected）。其它 `q.balance` 显示点不改：13450/13452、13460-13463（panel 折叠行纯文本聚合）、17113（card.title tooltip）、17800（无 parts 的 money 行）——均为纯文本无 meter；16323 `balanceAmount`（JS，keysSum 的 money 格式化）与 15648 keysSum（明确排除 balanceParts）不涉 percent。
3. 失败读取：percent 为 null 的 part（money/counts）走 `p.text` 原文、无 meter，两档不变（测试覆盖 money 卡）。

## 交付物

- 提交：579942e679de66090299ba73f8c071a9f9bfb89c，身份行 AUTHOR/COMMITTER=ggbdpq <ggbdpq@gmail.com>（git log -1 核验）。
- patch：`0001-usage-a-custom-provider-s-balance-percent-reads-as-L.patch`，SHA-256 前 16 = ecc4e6b2b6a0e830。
- 待发布稿：`3193-comment.body.md`。三件套自检：Attribution 行 grep=1、SHA-256 行 grep=1、Branch 行 grep=1；内嵌 patch 与磁盘 patch `diff` 逐字节一致（PATCH-IDENTICAL），内嵌 sha16 同为 ecc4e6b2b6a0e830；围栏外零中文（grep CJK=0）；无 AI use 段。

## 环境备注

- playwright 未随仓走：/tmp/pw-runner 装 playwright@1.63（其 chromium-1243 与本机缓存匹配），`NODE_PATH=/tmp/pw-runner/node_modules` 运行；1.64 需要 chromium-1248（缓存无）不匹配。
- 本机仅 Chromium 可跑（webkit 浏览器未装），全部 browser 跑次用 BROWSER=chromium。
