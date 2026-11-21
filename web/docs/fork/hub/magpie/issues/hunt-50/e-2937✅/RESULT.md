# hunt50 E · yetone/magpie#2937 · extraBody ${sessionId} 被全部 subagent 共享，prompt_cache_key 过载

日期：2026-10-20。分支：`hunt50-e-sessionid-cache`（worktree /tmp/magpie-h29，基线 upstream/main `7916045591c318c84fa894022516a7ebffc9a91e`，收工时无漂移）。**产出：patch**，commit `74a4562ed89083fbf184bf1d7e466ec4a330a2c2`（单提交，作者 ggbdpq，`Generated-by: GLM-5.3-Flash (ZCode)` 尾注）。未推送、未发评论（本车道只产工件）。

## 一、结论

走 patch 路径。reporter 的诊断在代码上完全成立，且他给的方案 1 恰好踩在一个现成信号上，接缝极小：

- `${sessionId}` 的取值点在 `forwardOnce`：`p.WithExtraBody(body, cmp.Or(sessionOf(in), conversationID(in, body)))`（internal/gateway/gateway.go:3899）。`sessionOf` 读 `session_id` / `x-claude-code-session-id` 等会话头——Claude Code subagent 发的是父会话 id，所以一个对话的所有 subagent 撞同一个 key，与 issue 实测的"key 过载、命中率掉"吻合。
- **subagent 区分信号存在且强**：`x-claude-code-agent-id`（`subagentOf`/`subOf`，gateway.go:6360）。Claude Code 只在 subagent 回合发送该头，对话自身回合从不发送；gateway 已在用（Desktop subagent 模型/effort 拾取、Routing 页标签）。reporter 建议的 `subOf(in)` 就是现成函数。
- 其它信号盘点（为什么不用）：`metadata.user_id` 是设备级（`{"device_id":...}`，见 bedrock/websearch 测试夹具），不区分 subagent；系统提示里的 subagent 标记需要解析 body 且脆弱；`subagentTurnOf`（要求带 tools、无 kind）是 Routing 标签用的窄判定，做 cache key 反而不该收窄（helper 调用跟 lead 同 shard 是对的）。

## 二、改动面（5 文件，+66/−18）

- internal/provider/extrabody.go：新增 `SubagentPlaceholder = "${subagentId}"`；`WithExtraBody(body, session, subagent)` 加一参，`withSession` 同深度递归替换两个占位符；`tested`（Test/Detect）传 `""`；包注释补一条 bullet。
- internal/gateway/gateway.go:3899：调用点加第三参 `subOf(in)`。
- internal/gateway/extrabody_test.go：新增 `TestExtraBodySubagentId`（Responses relay，同 session 头三连发：无 agent id / worker-a / worker-b，断言三个 key 互异且形态正确）。
- internal/provider/extrabody_test.go：`TestWithExtraBody` 补 `${subagentId}` 的填充与空值断言，调用点补参。
- docs/subsystems/providers-accounts.md：Extra body 行补 `${subagentId}` 语义（含空值语义与 #2937 引用）。

**语义要点（刻意保守）**：reporter 的方案 2（把 subagent 折进传给 WithExtraBody 的 session）会让所有现有 `${sessionId}` 用户的 key 无声漂移，违反本车道"不得无声改变现有 key"的红线，弃。方案 1 是 opt-in：不写新占位符的值逐字节不变；主线程占位符替换为 `""`（即 `"sess-1:"`，带尾冒号，可预期）；非 Claude Code 客户端永远得 `""`。

## 三、TDD 记录

- **RED**（基线产品码未动、仅加 gateway 测试）：三请求全得 `"sess-1:${subagentId}"`（占位符原样透传），三条断言全红：
  `--- FAIL: TestExtraBodySubagentId ... the lead's key "sess-1:${subagentId}" / a subagent's key "sess-1:${subagentId}"`。
- **GREEN**：改后 `sess-1:` / `sess-1:worker-a` / `sess-1:worker-b`。

## 四、验证矩阵（全部实测）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| targeted | `go test -run 'TestExtraBody\|TestWithExtraBody' ./internal/gateway ./internal/provider` | ok（注释修正后复跑仍绿） |
| -race targeted | 同上加 `-race` | ok |
| 全量 gateway | `go test -timeout 45m ./internal/gateway` | ok 383.2s（起跑后仅有一处新测试注释级修订，targeted 复跑绿兜底） |
| gofmt | 五个改动文件 `gofmt -l` | 干净 |
| vet ×3 | `go vet ./...`（darwin）、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` | 全过（darwin 的 trayimage cgo enum 警告为预存） |
| builds ×3 | `go build ./...`（darwin）、`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui ./...`、`CGO_ENABLED=0 GOOS=windows go build -tags nogui .` | 全过 |
| 沙盒 | gateway/provider 两包 TestMain 自隔离（temp HOME + 全套 XDG + marker），不触真实配置 | 满足 code-standards 第 2 条 |

未跑：gateway 之外的整仓 `go test ./...`（未触碰的包）、gui Playwright 套件——commit message 的 Not run 段和评论的 Not verified 段均已如实列出。

## 五、兄弟面核查（rg 在案）

- `SessionPlaceholder|WithExtraBody` 全仓：占位符只活在 extrabody.go；`WithExtraBody` 生产调用方仅 2 处（forwardOnce、tested），均已适配。
- `${…}` 替换语法无第二处实现（headers 等特性不读占位符）；web/src 与 site 无 `sessionId` 提示文案需要同步。
- 会话头族（`sessionHeaders`）与 `x-claude-code-*` 头在 gateway.go:4081 有脱敏清单（`anthropic-`/`x-stainless-`/`x-claude-code-` 前缀），本改动只读 header 不转发，无泄露面。

## 六、产物与遗留

- `/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt50/e-2937/2937-comment.body.md`：英文 patch post（分支行、What changed/Red/Verification/Siblings/Not verified、完整 format-patch 内嵌、AI 行不带模型名、Attribution 行）。发帖时需人肉确认 fork 分支已推送。
- 不确定项：(1) 中继对"同 key 不同后缀"是否必然分片暖存是 reporter 数据的推断，本机只能钉住 magpie 侧发出的 body 字节；(2) `x-claude-code-agent-id` 是否在所有 Claude Code 版本/渠道（终端 CLI、Desktop、第三方套壳）一致发送，仓库测试与 issue 正文都按"发送"处理，但没有版本号证据；(3) 上游 main 若在 key 拼接处继续演进（如 opencode_session.go 的会话别名），rebase 时 `forwardOnce` 调用点可能漂移，语义不变。
