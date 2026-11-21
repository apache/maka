# #2591 用量总 token 口径忽略 cache read — 定性分析

- 报告:n1majne3,2026-10-16 14:38Z,正文一句:"用量里面的总token量只考虑了输入和输出,没有计入cache read"。0 评论。
- 判定:**口径已被 #2378 裁决 + Sessions 页残留未接开关** → 定性分析评论(claim+评论合一),不 patch。
- 环境基线:upstream/main = 1d6f461a(pr3 工作树核实)。

## 口径地图(全部在 upstream/main 基线核实)

### 数据层:cache read 记了
- `internal/usage/usage.go:63-69`:`CacheRead int json:"cache_read"`("the prompt tokens read from the vendor's cache")
- `internal/usage/usage.go:378`:成本 `CostSplit(r.Input, r.Output, r.CacheRead, r.CacheWrite, r.CacheWrite1h)` — 成本计算已含 cache
- `internal/gui/assets/plugins/usage/page.js:419-421`:Overview 独立 "cache read" 卡片,带 hit rate + written

### 合计函数:同类型两个口径,均有注释声明
- `internal/usage/usage.go:427-428`:`Tokens() = Input + Output` — "Tokens is what went in and out, excluding cache traffic."
- `internal/usage/ledger.go:920-921`:`AllTokens() = Input + Output + CacheRead + CacheWrite` — "AllTokens is what went in and out and through the cache."

### 各视图实际口径
| 视图 | 位置 | 口径 | 备注 |
|---|---|---|---|
| Usage Overview tokens 卡 | page.js:412 | 可切换(usageTokens) | **#2378 昨天落的开关** |
| Usage 切换器 | page.js:344-365 usageTokensPick | localStorage `magpie.usageWithCache`,默认 Without | 注释:"as the Requests tab's total always has them" |
| Requests/ledger 卡 | app.js:17865 allTokens | 含 cache_read+cache_write | 一直含 |
| Requests 行详情 | page.js:832-833 | 四类分列 in/out/cache read/cache creation | |
| **Sessions tokens 卡** | **page.js:2340** | **硬加法 in+out,无开关** | **残留** |
| Sessions 行/聚合/日历/Top | page.js:2158/2404/2483/2666/2754 | 硬加法 in+out | 残留 |
| CLI usage | usage_cli.go:196/220/222 | Tokens() 不含 | 声明一致 |
| TUI | tui/pages.go:1186/1229 | Tokens() 不含 | 声明一致 |
| 托盘整窗 | trayusage.go:240,280 | Tokens()+CacheRead+CacheWrite 含 | |
| heatmap | heatmap.go:89 | 含 cache | |

## 关键时间线
- **#2378**(10-15 21:01 +0800 合并,d6b045a7):另一用户报"默认的token统计不包含缓存,可否增加参数包含?" 维护者回应:Overview tokens 卡标签变下拉 Without/With cache,默认不含;Requests Tokens 卡 wrap 修复。
- **#2591**(10-16 14:38Z 报):与 #2378 前半诉求几乎相同。报告者若用发布版,可能尚未含 d6b045a7;若已是最新构建,点 tokens 卡标签即可切换。

## 为什么不 patch
1. Overview(最显眼的"总 token")已被 #2378 裁决:默认不含 + 可切换。对同一诉求再 patch 即重复维护者昨天的工作。
2. Sessions 残留(2340 硬加法)是真实不一致,但维护者昨天改同一文件时**有机会接而未接**,可能有意(Sessions 已有独立 cache read 卡)。未见表态前 patch 有 #1569/#1917 式硬凑风险。
3. 前端 JS(page.js)无自动化测试手段(gui 测试是 Go 侧 API/settings 测试,如 usage_arrange_test.go),TDD 红绿不可行。

## 给维护者的裁量点(已写进评论)
- Sessions 页接同一 `usageWithCache`:复用 `usageTokens`,注意 `usageTokensPick` 回调写死 `renderUsage()`,需按当前页刷新
- CLI/TUI 含 cache 合计可另开单
- 默认值不动(#2378 刚裁决)

## 验证
- 本轮只读调查 + 评论,无代码改动,无测试执行
- 排雷:0 评论(发帖前重读确认)、无占坑 PR(`gh pr list --search "2591 in:body"` 空)、无交叉引用
- 同域:#2297(维护者已确认用我方补丁,战场 window_holds/codex_backend)、#2488(整窗美元合计)均与本单不同文件不同视图
