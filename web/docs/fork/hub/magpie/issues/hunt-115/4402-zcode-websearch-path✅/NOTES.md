# hunt115-b #4402 — ZCode plugin path WebSearch: the user's search=yes was dropped before the gateway read it

- 状态：已发布，等审。帖：https://github.com/yetone/magpie/issues/4402#issuecomment-6563571453
- 分支：fork `fix/4402-zcode-websearch-path` @ `4073c3652`（基线 upstream `de7953e3b`；发布时 upstream tip 已走到 89ffc58f5，provider.go 在 base..tip 零 diff，patch git am 可直接应用，未 rebase）
- patch：`4402.patch`，SHA-256 前 16 `4d7f0cd75ffac113`（format-patch -1 4073c3652）
- 防撞：我方 #4654（订阅路径 MCP 回调丢 caller 身份）正交——面不同（claude_subscription/access vs provider 持久化+插件 saidTo）、文件域不同。upstream 无 #4402 命中、无人在修（关键词 grep web search/zcode/search=yes 全过）。
- 根因：`accountSettings`（provider.go，#4738 的 Save↔withPicks 共用清单）不搬 `Searches` → CLI `search=yes` 收下即丢 → 插件 provider 只剩 `pp.Searches`（#2027），zcode 插件不声明 → `searchesItself` saidTo=false → 翻译路径按「只有自己会搜的才被要求搜」剥掉 `web_search_20250305` → 上游拿到的请求无任何工具，请求仍 200。
- 修法（1 行 + 3 行注释 + 1 测试）：`a.Searches = a.Searches || pk.Searches`（one-way：用户的 yes 保留、no 只收回用户自己的 yes、插件自身声明永不被 pk=false 回灌）。测试 `internal/gateway/zcode_search_test.go`：fake 插件 FAKE_ZCODE（GLM-5.3 @ai-sdk/anthropic，与 zcode 同形）+ vendor 记录收到的请求，断言 search=yes 落盘且 vendor 被 offer web_search。
- RED/GREEN：RED 双断言（`search=yes was not kept` + `the vendor was offered null`）原文 red.log；GREEN green.log；消融（checkout 父提交只回退 provider.go）回红原文 ablation.log，恢复复绿。
- 矩阵：provider 全量 ok 102.5s；gateway 全量唯一红=预存 flake TestCodexPoolSaysTheClientsVersion（派单已记录），单跑复绿，同轮我的测试绿；定向 -race 绿；gofmt 干净；vet nogui 干净（gui cgo warning 预存）+ 三平台 vet 干净；nogui build darwin/linux/windows 干净。
- 兄弟面（12 触点全查不改）：searchRank 强制 Searches=false（#359 不花 relay 配额）不变；namedSearcherRank/RelaysSaidToSearch 变成「可手工指名」正确；searchesItself 账号分支只对 IsPlugin 读 saidTo，内置 claude/codex/copilot 行为不变；GUI 编辑器同一 Save 路径一并修好；backup/davsync 原样透传。
- 失败语义：merge 无错误路径；providers.json 读档失败→picks 零值→插件声明照旧，无新失败模式。
- 热路径：accountSettings 只在 provider 列表构建时跑，非每请求；bool OR 零成本；search=yes 的 provider 声明搜索的请求从翻译改 relay（更便宜），其它请求零变化。
- 未验证：真机 ZCode 账号对 bigmodel 生产端点（本地为替身插件+假 vendor 离线复现）；报告者观察的响应形状由修前测试状态对上，非实弹。
- 不写 journal（按派单指示）。
