# hunt61 Lane B — #1448 验证日志（2026-10-22）

分支：`hunt61-b-1448-namespace-tools`，head `9e3ed461a5f8649bdbeab5e1774a6a99d4755ff6`（基线 `7dd965ed22e6619c9084f3bca58e444073e8a41c` = upstream/main 当时最新）。
身份：author 与 committer 均为 `ggbdpq <ggbdpq@gmail.com>`（`git log -1 --format` 核验）。
patch：`0001-gateway-a-Responses-client-s-namespace-tools-go-to-t.patch`，SHA-256 前 16 `681ad982b2d30912`。

## 前提核验（全过，未弃单）

- `gh issue view 1448`：0 评论，报告含沙箱复现（临时 HOME + 假上游 + 真 muse 1.4.4），错误文本 magpie/muse 均无 → 来自 Cline API。拍平点：`internal/gateway/responses.go` parseResponses namespace case；映射回：`callTo` + `Request.Namespaced`（`gateway.go:6232` 注入 encoder）；`provider.FlatName`（`internal/provider/grok.go:331`）。
- `gh issue view 1393`：先例 = 内置 Kiro 的「头 + 全名哈希」短名，每轮一致，回程还原（f575da41 本体只是插件版本号一行，真机制在 e3b6397a 起的内置 + 插件）。#1448 延伸方式：不发明新表——复用现有 `Namespaced`/`callTo` 映射，声明侧改用模型会说的名字。
- 关键定性：Grok 订阅/plugin 走**原始 body 中继**（`provider/grok.go` grokShaped/grokFlat，#404），不经 IR；若只改 IR 会让 Grok wire（拍平）与映射键（裸名）脱节 → 解法 = `Namespaced` 同时登记裸名与拍平名（同一张表加一键），Grok 路径零改动，grok_namespace_test / plugin_grok_parity_test / provider/grok_test 全部原样绿。

## TDD

- RED（基线产品码 + 新测试）：9 失败。关键摘录：
  - `TestNamespacedToolsForwardedBare: forwarded = exec_command,collaboration__spawn_agent,collaboration__freeform`（= Cline 收到的声明清单形状）
  - `TestNamespacedBareCallBack: output = [map[... name:spawn_agent ...]]`（回程丢 namespace = 客户端可见失败形状）
  - `TestCodexCustomToolsTranslated` 失败输出里原样可见 chat wire `"name":"collaboration__spawn_agent"`。
- 报告者沙箱复现未重跑（本机无 muse 二进制、无 Cline key），按其记录的形状做断言级等价复现，英文稿正文已注明。
- 最小修复：`internal/gateway/responses.go` 增 `offeredNames`/`offeredName`；三处消费点（历史 function_call/custom_tool_call、namespace offer、allowed_tools）+ namespace offer 双键登记 + allowed 过滤保留裸名工具的拍平键。裸名条件：未被任何顶层名/其它命名空间裸名/任何拍平名/客户端执行的 tool_search 认领，且长度 ≤64。
- GREEN：定向全绿；`./internal/gateway` 包全量 ok（327s）；`./internal/provider` ok（77s）。
- 消融：产品码单文件 checkout 回 `7dd965ed`、测试保留 → 11 红（TestAdditionalToolsTranslated / TestCodexCustomToolsTranslated / TestCodexCustomToolNamespaced / TestNamespacedCallKeepsArgsWhenSearchTakesOver / TestNamespacedToolsOffered / TestNamespacedBareNameClaimed / TestNamespacedToolsForwardedBare / TestNamespacedBareCallBack / TestNamespacedCallInHistory / TestLongNamespacedNamesFit / TestParseResponsesAllowedNamespacedTool）；恢复 → 绿。

## 兄弟面（Watched ②）

改：`internal/gateway/responses.go`（IR 翻译路径）+ 6 个测试文件的期望名。
不改及理由：
- `provider/grok.go` grokShaped/grokFlat/flatCall：原始中继重塑，wire 保持拍平；回程由拍平键承接（grok_namespace_test 等原样绿）。
- `provider/zed_body.go`（Zed 插件，客户端方向）：不涉。
- `gateway/additional_tools.go` liftAdditionalTools：Lite `functions` 溶解先例，仅在 additional_tools 存在时触发，保持原样。
- `gateway/prompt.go` `__` 消费：展示/计账读客户端原始请求，不涉。
- `gateway/image_tool.go` withoutImageToolReq 按 `Namespaced` 键剔除，裸名下照常；测试假上游谓词 `hasImageTool` 增补 `"name":"imagegen"` 形状（#949 链路端到端绿）。
- 内置 Kiro 长名截断（#1393 机制，provider 层 + 插件）：正交，不动；裸名提供反而使多数长名不再走到截断。
- `callTo` else 分支（未知名透传）：失败读取 = 退回今天的行为，不炸（Watched ③；nil map 查询安全，且有命名空间工具时 named 必非 nil）。

## 矩阵（退出码）

| 项 | 结果 |
|---|---|
| 定向测试（gateway -tags nogui） | ok |
| gateway 包全量 -tags nogui | ok（326.8s） |
| provider 包全量 -tags nogui | ok（77.1s） |
| `gofmt -l internal/gateway internal/provider` | 无输出 |
| `go vet ./...`（darwin） | exit 0（gui 有预存 C 编译 warning，不失败） |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `go build` darwin/linux/windows（仓库根 main 包） | 三平台 ok |
| `git am` 校验（临时 clone 于 7dd965ed） | 干净应用，落 b86e10bd，作者 ggbdpq |
| 预存红 TestMothX / TestProxyCheckSaysAProxyPassedBy | 基线与本提交同样红 → 预存，与本改动无关（在 internal/agent、internal/gui，非改动包） |

## 交付物

- 提交：`9e3ed461a5f8649bdbeab5e1774a6a99d4755ff6`（单提交，8 文件 +222/−39）
- patch：本目录 `0001-gateway-a-Responses-client-s-namespace-tools-go-to-t.patch`
- 待发布稿：本目录 `1448-comment.body.md`（三件套 grep 各 1；正文零中文）

## 不确定项

- 修后 Cline 上的真实 Muse Spark 行为未实测（无账号）——修复使「声明 = 模型可能说的名字」成立，但若该模型召回的名字既非裸名也非拍平名，仍会被 Cline 拒（magpie 无法穷举）。
- 裸名提供改变了所有翻译路径上 Responses 客户端命名空间工具的 wire 名（含翻译路径上的 Responses 上游，如 Codex Ultra/Copilot）；碰撞规则保证唯一性，codex_ultra 测试已更新且绿。此点已在英文稿中明示。
- 环境事故记录：一次 python 相对路径编辑误落主 clone（cwd 重置陷阱），已当场 `git checkout --` 还原并核实主 clone 干净；worktree 侧重做。
