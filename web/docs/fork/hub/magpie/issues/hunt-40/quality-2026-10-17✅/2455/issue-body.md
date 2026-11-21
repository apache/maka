# 本地待发布修订稿：#2455

未发布到 GitHub。复核基线 `6f950653fcdb46c73044a071328cdc508f12ccef`。本轮核对 `/private/tmp/magpie-quality-20261017-2455`：`busy.go`、`go.mod`、`Makefile`、`importapps.go` 与该提交逐字节一致。相对该提交有差异的是本补丁的七个文件：`patience.go`、`fallback.go`、`gateway.go`、`continuation.go`、`search.go`、`docs/subsystems/gateway-routing.md`，以及基线没有的 `streamless_member_test.go`。`updated.patch` 是相对该基线的 unified diff，不是新提交，维护者也尚未采纳。

## 已证明的行为

来源是代码审计和 scripted httptest，不是一份真实 relay 的失败记录。假上游对请求回 `200` + `application/json`。翻译路径把它报成 502 `did not stream`，但 `passing()` 和组 Patience 的 `busy()` 仍当成可能自行恢复的失败，于是继续问同一个成员。下一成员仍可被问到。

测试二进制在 `internal/gateway/retry_test.go` 的 `init` 里把 `retryPause` 设成 `1ms`。在这个条件下：

- `BASELINE.log`、`ABLATION.log`：`TestStreamlessMemberIsAskedOnce` 的 whole / stream 都失败，输出 `asked 15 times`。
- `MODIFIED.log`、`RESTORED.log`：同一测试通过；`TestStreamlessMemberHandsOnToTheNextMember` 在四份日志里都通过。

这四份日志没有保存原始命令行。15 次是上述测试二进制里的计数，不是生产配置下重新测量的次数。

## 不能外推的收益

生产代码里 `retryPause` 的初值是 1 秒。还会不会继续问、一共问几次，取决于每次请求耗时、Retry-After、组 Patience（默认 60 秒，上限 240 秒）和客户端是否取消。本轮没有真实供应商的账单或限速计数，不写「每次浪费 12 次计费请求」，也不写「默认必问 15 次、必等 60 秒」。

若真实 relay 只是偶发回非流 JSON，这次「不再重问」是否合适由维护者判断。同协议直通时，200 非流 JSON 仍会原样透传；本补丁没有改那条路径。

## 未完成

定向日志之外，四份补丁叠跑的 `go test -tags nogui ./...` 退出码 1，见 [组合结果](../integration/RESULT.md)。不把这四份日志写成全仓通过。没有真实不支持 SSE 的 relay，也没有 GUI Routing 页验收。没有新证据时不催。

AI 协作：本轮由 Codex 核对固定 main 与副本哈希，并按已有日志收窄收益表述。提交者仍需自己解释根因和取舍。
