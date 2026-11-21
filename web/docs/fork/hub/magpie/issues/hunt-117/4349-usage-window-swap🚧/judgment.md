# #4349 用量窗口 requests/tokens 显示相反 — 车道 C 判定记录（2026-11-02）

## 结论：降级澄清帖（判定门 Q2：钉不死，不硬凑）

正文仅一句「点击请求显示的是token数，反之亦然」（c=0、无截图、无日志、无版本、无点击路径）。
对 upstream/main tip f3551387c（开工时）全量核查以下绑定点，均无 requests↔tokens 对调：

1. 用量页 tab 条 USAGE_TABS（plugins/usage/page.js:2666,2718）— 按钮按 id 绑定，pane 按 id 显隐，正确。
2. Requests tab 指标切换 LED_TREND（page.js:1475,1711）+ ledValue/ledPart（app.js:18601-18605）— calls→p.calls、tokens→allTokens(p)，正确。
3. 热力图 LED_HEAT（page.js:1754-1818）— value() 按 metric 取 tokens/calls/cost，tooltip 重排 order 表正确。
4. tray 面板 Usage tab（app.js:17015-17200）— LED_METRICS segs 按 id 绑定 panelUseMetric；blk("Tokens",allTokens) / blk("Requests",l.calls) 正确。
5. Requests tab via tiles（page.js:2270-2306）— calls 带 "requests" 单位、tokens 在 sub，正确。
6. Overview tiles（page.js:625-650）— 不可点击，绑定正确。
7. i18n（assets/i18n.js 全部 8 处）— "Tokens"→Token / "Requests"→请求，无任何语言交换；plugins/usage/i18n.js 无冲突词条。
8. Go 侧 usage.Totals JSON 标签（usage.go:509）、Part.add/plus（ledger.go:1046-1087）、Share/Breakdown、LedgerSeries、buildRequestBlocksIn（request_page.go:2420+）— calls/tokens 字段一致。
9. TUI quotaCell（tui/pages.go:1483）、tray 窗口行（trayusage.go trayCardText）、remote_key_limits.go keyLimitCard — 每窗口读自己的数。
10. 订阅卡 quotaWindows/quotaText/quotaCount（app.js:18430,14141,14186）— quota-n 点击只切全局 used/left，不涉 requests/tokens。

唯一无法本地排除的位置：某 vendor/插件把名为 "Requests"/"Tokens" 的两个窗口数值本身报反（plugin_usage.go:158 沿用 vendor 原名透传）——数据源在仓外，需报告者给出 provider 名才能核。

## 证据链
- take：comment-6578536990（body "take"，GET 回读核实）
- 澄清帖：comment-6578541834（英文，请报告者给截图+版本+点击路径+provider 名；列出已核查面；GET 回读一致）
- POST 前门禁：fetch 后 upstream 前进 f3551387c→d29f02d65，`--grep 4349` 无命中，"usage window"/swap 关键词无相关新提交；issue 仍 OPEN、0 评论、无 assignee（take 时复查）
- 未推分支、未产 patch：无代码改动，分支 fix/4349-usage-window-swap 仅停在 tip，收尾已删

## 后续条件
报告者回复（截图/版本/点击路径/provider 名）后按新证据重新判定；若指向 vendor 数据源反了，则属插件/上游问题，转 plugins 仓库。
