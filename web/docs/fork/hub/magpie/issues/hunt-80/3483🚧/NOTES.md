# hunt80-c #3483 NOTES

## 基线
- upstream/main @ 7b1faf99f2a36732a836fd135a7a2f937b4ed3e9 (agent: a Codex auth.json caught mid-rewrite...)
- worktree /tmp/magpie-hunt80-c, branch hunt80-c-3483
- 占坑：#3483 OPEN, 0 评论, 无 assignee, 无 open PR → take @ issuecomment-6387625720

## 机理（实测代码）
- app.js:5811 `else if (!providers) { ... renderProvidersLoading(); }` — view=providers 且无数据时画骨架
- app.js:5930-5946 renderProvidersLoading(): 5 条 `el("div", "row provider pv-sk-row")`
- app.js:5814 `const next = await fresh`（api("providers") = GET /api/providers）→ renderProviders() → onList.replaceChildren() 原子换真行
- 引入提交：837923c4 "providers: the page shows its rows as they load, skeletons..."
- spec: context-picks.test.cjs:56 `await page.locator(".row.provider").click()` — goto 后立即点，落在骨架窗口期 → strict violation 5 elements（全部 pv-sk-row，真行未渲染所以恰 5 个）
- 测试 fixtures：1 个真 provider（relay）→ 真行渲染后 `.row.provider` 恰 1 个

## 先例
- #2640（name-suffix-where-named，同病）仍 OPEN 0 评论未修
- 仓内 idiom：providers-last-known.test.cjs:67 `page.locator("#providers .row.provider:not(.pv-sk-row)")`；agents-last-known.test.cjs:86 同款
- issue 原文建议：Wait for a real row (`.row.provider:not(.pv-sk-row)`)

## 修法（选定）
- context-picks.test.cjs:56: `.row.provider` → `.row.provider:not(.pv-sk-row)`
- 依据：Playwright click 对空命中定位器自动等待（actionability），骨架期 0 命中→等 renderProviders 换真行→strict 恰 1 命中。单行 diff，不改断言本意，与仓内 idiom 一致。

## 兄弟面（.row.provider 裸点击点判定）
- context-picks.test.cjs:56 — 本单修
- model-reasonless.test.cjs:71 裸 — 同病候选，未报红，不改（超本单范围）
- readable-focus.test.cjs:93,127 `#providers .row.provider` 裸 — 同病候选，未报红，不改
- 其余全部带 hasText/filter/.first()，骨架行无文本不命中，天然免疫
- pv-sk-row 其它 spec 消费方：providers-last-known / agents-last-known 已用 :not()，不改

## 环境
- NODE_PATH=/Users/ggbdpq/.npm/_npx/e41f203b7505f1fb/node_modules (playwright 1.57.0)
- 禁 --test-name-pattern；红绿判定全跑

## 最终交付（2026-10-25）
- commit: 5287712f2109a0f2d47e5a11a0dc911b28b9173d（rebase 后；初版 869ef489→amend 6e2e549a→rebase 5287712f，树内容全程同一行 diff）
- 基线：分支切于 upstream/main 7b1faf99f；发布前上游推进 40a0b442c（internal/cli-only，本单文件零交集）→ 按先例 rebase + 重验
- patch sha256 前16: 8014b79aa929becb（对 7b1faf99f 与 40a0b442c 两代 pristine apply --check 均 clean）
- take: issuecomment-6387625720；交付帖: issuecomment-6387830092（GET 回读全项命中）
- 新基线 watched 重做：消融回红 10/10 红同签名（ablate-red2.log）、注入 GREEN 10/10（green-injected2.log）、干净 3×20/20（rebase-run-1..3）
- 旧基线（7b1faf99f）记录：注入 RED 10/10 同签名、注入 GREEN 10/10、消融回红 10/10、干净 10 连跑 200/200、plk 40/40、mta 10/10
- fork branch: ggbdpq/magpie hunt80-c-3483 @ 5287712f（force-with-lease 推送，ls-remote 比对一致）
