核实了，已修，patch 在本评论末尾（分支 [hunt31-a-audit-caller-key](https://github.com/ggbdpq/magpie/tree/hunt31-a-audit-caller-key)，commit `0bced626`，基于 main `ea3dee96`）。

## 根因（对照 main `ea3dee96`）

- `writeTiers`（`internal/agent/claude.go` 的 `env.ANTHROPIC_AUTH_TOKEN` 写入处）：每次模型/tier 写入无条件写 `wiredKey()`，既不问 `gatewayTakes` 也不 stash——用户 caller key 被直接覆盖，且无任何记录可找回。
- `putProvider` 与线程 provider 表写入（`internal/agent/codex.go` 两处 `experimental_bearer_token`）：同样无条件写 `at.gwKey()`，本单点名的 Codex 兄弟面。
- #2510（`d9b94355`）修好了 Check 误报（`wiringOff` 走 `keyHolds`）和 sync/install 侧的覆盖（`mergeKept`、Reasonix install），但没动这三处直写——本单复现里的第 4 步仍丢 key。本帖红测试也证实：Check 对 caller key 已静默，模型写入仍覆盖。

## 修法

- 三个写入点都在写前问一次 `keyHolds(现值, 将写值)`：现值是网关会认证的 caller key（`access.Authenticate` 通过）就保留用户值不写；网关会拒绝的值（外来 key、已停用的 key）仍自愈回 magpie 的 key。与 sync 侧 `mergeKept` 的 #2510 语义一致。
- 登录字段自己的 Set（`claudeai` 开关）照单内建议不动。
- `docs/subsystems/agent-wiring.md` 同步一句：原文"a key put there by hand is reported by Check, not taken for magpie's"自 #2510 起已不准确。

## 验证（ea3dee96 + 本 patch，t.TempDir 沙盒 HOME）

| 检查 | 结果 |
| --- | --- |
| 修前红（显式摘 `claude.go`+`codex.go` 两产品文件跑新测试） | 两测试断言红：`a model pick wrote over the user's caller key`，形状与本单第 5 步一致（claude：`ANTHROPIC_AUTH_TOKEN: "magpie"`；codex：`experimental_bearer_token = "magpie"`） |
| 新增 `TestClaudePickKeepsAGatewayKeyOfTheUsers` / `TestCodexPickKeepsAGatewayKeyOfTheUsers` | caller key 拾取后存活、外来 key 仍被自愈，绿 |
| 定向族 `TestClaude|TestCodex|TestKeyHolds|TestHermes|TestDsh|TestQwen`（`go test -tags nogui -p 2`） | ok（83.8s） |
| `gofmt -l internal/` | clean |
| `go vet` darwin / linux(nogui) / windows | clean |
| `go build` darwin / linux(nogui) / windows | ok（`trayimage_darwin.go` cgo `-Wenum-conversion` 与 ld 重复库警告，已知环境噪声） |

## 没跑什么

- 真 Claude Code / Codex 对着改后配置实跑（测试用沙盒 HOME 与假 provider，走与产品同一代码路径的 `Field("model").Set`）。
- internal/agent 全包套件（本机负载下 45 分钟起，只跑了上列定向族）。
- 线程 provider 表写入点的守卫对真实 Codex 会话文件的行为（该点只写 config 里尚不存在的表，`keptBearerToken` 在那里是空操作；保留守卫是为兄弟面一致）。

另外 `http_headers` 里的 `x-openai-actor-authorization: "magpie"` 保持原样——它是 provider 身份标记不是凭据；若这处也要守卫请说一声，我再补。

合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

Generated-by: GLM-5.3-Flash (ZCode)

PATCH_DETAILS_HERE
