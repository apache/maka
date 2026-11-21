# #3193 验证证据（Lane E，hunt66）

对象 commit：skygunner 15759adb4a09dcafd0b11980ddc0cbae385c65bf（帖 6351631831）。我方原 patch：579942e6（hunt60-a-3193-balance-toggle）。

## 1. attribution 实查

- Author: vincent <webmaster@palmit.com.au>（AuthorDate 10-23 07:12 +1000；CommitDate 07:19——amend 过一次）
- trailer 逐字摘录：`Co-authored-by: ggbdpq <ggbdpq@gmail.com>`（命中）
- message 声明：`Adapt ggbdpq/magpie 579942e679de66090299ba73f8c071a9f9bfb89c, retain the regression, and expand it...`

## 2. 保真对比

产品面（app.js）：
- panelBalances 三处 `p.text → balanceText(p)`、balanceRow 一处同：与我方逐字同一。
- balanceMeter：share→used 改名、`fill.style.width = (quotaLeft ? 100 - used : used) + "%"`、nearly-full 色键 used>=90：与我方逐字同一。**Left 语义=剩余份额填充，无行为分叉**。
- **balanceText 实现（精炼非分叉）**：我方手写补数+`t("{n} left")`；对方一行 `return p.percent == null || !quotaLeft ? p.text : quotaText({ used: p.percent })`。与 tip 上 quotaText 实现（app.js:13547）逐项核对：同 clamp、同 `quotaLeft ? 100-used : used`、同 `Number.isInteger ? n : n.toFixed(1)` 舍入、同 "{n} left"/"{n} used" i18n 键；`w.unlimited`/`quotaCount` 分支对 `{used: percent}` 入参不可达 → **输出等价**。Used 侧两者都返回 `p.text`（回复原数）。

对方多出的面：
- `docs/subsystems/gui-shell.md` +5 行（我方未触文档）。
- `core_budget_test.go` appScriptBudget 1_335_000→1_335_100（+100，理由"reusing quotaText 后超 57 字节"）——**其基线特有**，见落地节。
- 测试扩展：123→136 行，diff=127 行（5 语言 en/zh/zh-TW/ja/de vs 我方 2；Usage 900/1280px 与 panel 440/360px 两档 vs 我方单档；新增 `/api/settings/quota-left` 路由真实点击面板开关）。

## 3. 漂移与落地

- 15759adb^ = a11d605e，merge-base = 63be4771，`63be4771..a11d605e` = 478。
- cherry-pick 到 tip：两处冲突。
  1. app.js：3-way 把对方基线的 balanceShown 块错位对齐（tip 已有 balanceShown，仅一处）→ 解法=只保留其单行注释意图，丢弃重复块；balanceMeter 主体与 balanceText、四处调用点自动合并到位。
  2. core_budget_test.go：对方预算值/超长历史注释与 tip 值冲突 → **先保 tip 原值（1_250_000/1_426_000）实测**：`go test -tags nogui -run '^TestCoreScriptBudget$' ./internal/gui/` → `ok 1.252s`——tip 的 app.js 远小于其基线，+100 无需要；同时摘掉两条对其基线为真、对 tip 失真的注释行（"#3193 adds... 57 bytes beyond its previous limit"）。该文件解析后与 tip 逐字节还原（最终 stat 中消失）。
- 本地 commit 1cab5f77：3 文件 +153/−8。

## 4. 本机可跑的验证

- `TestCoreScriptBudget`：ok（上）。
- `node --check internal/gui/assets/app.js` → 语法 OK（合并产物可解析）。
- 关键行核对：balanceText 4 个调用点（app.js:16651/16654/16658/17464）、balanceText 定义 :17485-17486（quotaText 复用形）。
- gofmt -l core_budget_test.go → 空；`go vet -tags nogui ./internal/gui/` → 净 exit=0。

## 5. 消融回红

**本机不能跑**：行为回归是 `balance-quota-left.test.cjs`（Node test runner + Playwright，chromium/webkit 双引擎）；本机 worktree 无 node_modules/playwright 及浏览器，安装属环境变更超出本轮授权。对方帖宣称：新回归在旧渲染器上红（等 "91.1% left" 超时）、修复后 40 用例绿（双引擎、5 语言、双宽度、真实开关点击）；我方原帖宣称同形 RED（等 5s 超时）+ Chromium 4/4。两份声明均引用未复验，如实标注。

## 6. 兄弟面

余额渲染点=两处（panelBalances 托盘、balanceRow Usage 页），均已过 balanceText/balanceMeter；无 percent 的 part（money/counts）不建 meter（测试断言 `quota-track` count 0）。Go 侧 BalancePart.Text/Percent 不动（余额行、tooltip、history 仍报回复原数）——与我方原设计一致。

## 7. 未跑/未验

- Playwright 浏览器套件（本机无环境）：RED/GREEN 均未在本机复验。
- WebKit、真实供应商余额端点：双方都未验。
- gui 包全量：未跑（对方报 TestProxyCheckSaysAProxyPassedBy 预存红，与本改动无关；我方 journal 同记录）。
