# hunt115-b3 #4654 — Claude subscription: web search from the MCP helper callback ignores the calling gateway key's account list

- 状态：已发布，等审。帖：https://github.com/yetone/magpie/issues/4654#issuecomment-6556397298
- 分支：fork `hunt115-b3-4654` @ `d1fc7cb7f`（rebase 到 upstream `f823657d7` 后；开工基线 `77e853588`）
- patch：`4654.patch`，SHA-256 前 16 `ab889994f1a1d852`（format-patch -1 d1fc7cb7f）
- 根因：`mcpCall` 的 search 分支用 helper 回调请求的 context（lanGuard 对 ownCallback 放行不带 identity）→ `s.webSearch` → `searchWith` 内部请求走 `s.serve` → `accountHolds` 空 → `accountAllowed` 对空 Accounts 全 true → 共享顺序第一账号；usage 行 `appendUsage`/`search_api.go:195`/`search_native.go:106` 读 `access.Caller(ctx)` 得空。
- 修法（4 块）：`access.IdentityByID(id)`（On 的 identity 版，按 id 现读 key 设置，含 issuer fold）；`subscriptionRun.callerKeyID`（启动时记 access.Caller().KeyID，""=无 key caller 行为不变）；`mcpCall` search 分支重建 identity、解析失败 fail-closed（tool result IsError）；两条复用路径（serveSubscription match 串 + serveClaudeSubscription start 闭包 resume）跨 key 不复用（`anotherKey` log）。
- RED/GREEN：四测试 `claude_search_caller_test.go`（A 落点凭据+usage、B 禁 key 后 fail-closed（文件信号两连搜）、C match 复用、D idle 复用+同 key 对照）。修前四红原文在 red-*.log；消融 M1（mcpCall identity 段）/M2（match 判定）/M3（idle 判定）逐块回退产品文件各自回红，abl-*.log。
- 兄弟面（6 项全查）：claudeMCPPath 双注册同 handler；ownCallback 唯一入口 lanGuard；回调路径唯一出站=search（waitTool/pending 不出站）；vision/codex titles 从主请求 ctx 出站无此病（magpieChose 只豁免模型限制不豁免账号）；usage 三写入点全随 ctx 自动修复；forwardCallback 转发旧 magpie 自行判定。
- 失败读取语义：`IdentityByID` 的 load() 读档失败同返回 false → fail-closed 拒绝搜索，不按无限制放行。
- 热路径：每次 web search 一次 caller-keys.json 读（非每请求），access.mu 与 identifyCaller 同锁，频率低无争用。
- 矩阵：定向四测试（含 -race）绿；access 包全量绿（含 -race）；gateway 包全量 nogui 绿（577.9s）；gofmt 改动文件干净；vet nogui darwin/linux/windows 干净；build nogui 三平台干净（darwin gui cgo warning 预存，gui 包未触碰）。
- 门禁：upstream 无 #4654/claude-mcp/caller 自修；e5f66f8a6 触及 claude_subscription.go（TUI 区）→ rebase `d1fc7cb7f` 重跑定向绿。
- 未验证：真实 Claude 订阅账号/受限 key 对生产网关——复现为包内替身+假上游（离线）。
- 不写 journal（按派单指示）。
