我来核了一下口径:cache read 的量 magpie 记了、也到处展示,缺的不是数据,是「总 token」这一个数的计法——而这个计法昨天(#2378,d6b045a7,10-15 合并)刚被做成可切换的。

**1. cache read 记了,展示也在**

账本每条记录都带 cache read/cache write(`internal/usage/usage.go:63-69`),成本也把它们计进去了(`usage.go:378`)。Usage 页 tokens 卡旁边一直有独立的「cache read」卡,带 hit rate 和写入量。

**2. 概览页的「总 token」已经可以计 cache(#2378,可能还没进发布版)**

概览页 tokens 卡的标签现在是个下拉:Without cache / With cache(存 `magpie.usageWithCache`,默认不含;`internal/gui/assets/plugins/usage/page.js` 的 `usageTokensPick`)。Requests 页的 Tokens 合计则一直含 cache(#2378 注释原话:"as the Requests tab's total always has them")。如果您用的发布版还没到 10-15 的构建,这个切换可能还没到;如果已是最新构建,在概览页点 tokens 标签选 With cache 即可。

**3. 真正的残留不一致:Sessions 页没接这个开关**

#2378 只改了概览(renderUsage)。Sessions 页的 tokens 卡还是硬加法 `tot.input + tot.output`(`page.js:2340`),列表行 `sessTokens`(`page.js:2158`)、按模型/项目的聚合 `sessSums`(`page.js:2404`)、日历(`page.js:2483`)、「Top 会话」(`page.js:2754`)也都不看 `usageWithCache`——开关开着的用户,概览和会话两页的数对不上。CLI/TUI 的 `Totals.Tokens()` 同样是 in+out(`usage.go:428`,注释明确 "excluding cache traffic"),但托盘整窗和热力图是含 cache 的(`trayusage.go:240`、`heatmap.go:89`)。

给维护者的裁量点:

- Sessions 页要不要接同一个 `usageWithCache`:改动不大(复用 `usageTokens`),但 `usageTokensPick` 的回调现在写死了 `renderUsage()`,接的时候要按当前页刷新;
- CLI/TUI 要不要提供含 cache 的合计,可以另开单;
- 默认值不建议动,#2378 刚裁决过默认不含。
