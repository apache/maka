# #4678 plugin task lifetime — 验证证据（hunt-115-b7，2026-11-01）

- 上游开工 SHA：`9d08993c8bd40de5d002bc364a16be344c5d78fa`
- 分支：`fix/4678-plugin-task-lifetime`（fork ggbdpq/magpie），head `b2c162d2e07ee7176130b883527beb6cfd45dd00`
- patch SHA-256 前 16：`be2d11fa6d04dadc`
- 帖：https://github.com/yetone/magpie/issues/4678#issuecomment-6557828924（GET 回读通过：Attribution/patch 块/分支链接/零中文/无 AI use 段）
- 占坑：https://github.com/yetone/magpie/issues/4678#issuecomment-6557528606

## RED（父提交 9d08993c，测试已就位、产品未修）

```
=== RUN   TestOrdinaryCallCancelTellsTheHost
    plugin_rpc_cancel_test.go:30: the host was told of the cancellation didn't happen
--- FAIL: TestOrdinaryCallCancelTellsTheHost (5.00s)

=== RUN   TestCancelledUsageReachesThePlugin
    plugin_rpc_cancel_test.go:69: the plugin's usage hook was handed a signal didn't happen
--- FAIL: TestCancelledUsageReachesThePlugin (6.08s)
```

（Test C `TestModelListDeadlineTellsTheHook` 与 A/B 同批补写，RED 面同构：修前 hook 无 signal 可挂、deadline 不 abort，此处未单独截 RED 原文，其消融回红原文见下。）

## GREEN（b2c162d2e）

```
--- PASS: TestOrdinaryCallCancelTellsTheHost (0.00s)
--- PASS: TestCancelledUsageReachesThePlugin (1.08s)
--- PASS: TestModelListDeadlineTellsTheHook (2.05s)
ok  	github.com/yetone/magpie/internal/plugin
```

## 消融回红（只回退产品文件，测试保留；基线=分支父提交）

1. host.go `c.cancellable = method != "init"` → `== "gatewayRequest"`：
   `plugin_rpc_cancel_test.go:30: the host was told of the cancellation didn't happen` → FAIL
2. host.js dispatcher `fn(params, ctl.signal)` → `fn(params)`：
   `plugin_rpc_cancel_test.go:69: the plugin's usage hook was handed a signal didn't happen` → FAIL
3. host.js inTime `ctl?.abort()` 删除：
   `plugin_rpc_cancel_test.go:116: the deadline aborted the models hook didn't happen` → FAIL
   （消融 2 下 Test C 仍绿属预期：C 锁 deadline→abort 面，B 锁 dispatcher→hook 面）

恢复后三条全绿。

## 矩阵

| 项 | 结果 |
| --- | --- |
| `go test -tags nogui ./internal/plugin/`（全量，当前代码） | 唯一红 `TestHostToldTheGatewayAddress`，父提交同样红 → **预存**（host_addr_test.go:78，端口迁移地址传递，与本单无关） |
| `-race`：新增三条 + TestHostCancelAfterHeadStopsTheFetch / TestRefreshInvalidationCancelsStaleCall / TestRefreshSingleFlight | 全 PASS（自查出一处**测试自身** race：无锁读 `h.calls`，改 `f.mu` 下读后干净；产品代码无 race） |
| 全量无 DATA RACE | 是 |
| `gofmt -l internal/plugin/` | 干净 |
| `go vet` / `GOOS=linux go vet -tags nogui` / `GOOS=windows go vet`（改动包） | 全过 |
| `go build` darwin / linux(nogui) / windows（全仓，pipefail 下退出码） | 0 / 0 / 0 |
| 门禁：`git log 9d08993c..upstream/main` 自修 grep `#4678|deadline|plugin.*task|cancell` + 文件冲突 diff | 无新提交，无命中，无冲突 |

## 兄弟面清点（rg 全查，改/不改理由）

- fetch（`inflight`）/ gatewayRequest（`gatewayInflight`）：已有完整取消链，不动。
- `init`：显式排除 cancellable——超时由 `h.stop()` 兜底，abort 中断自身加载无收益。
- 其余普通方法（authorize/callback/load/prompt/validate/apiKey/checkin/tool/import/take/signOut/gatewayStates/setProviderOptions/check）：同一共享根因面，统一 cancellable；不认 signal 的 handler 行为不变（任务跑完，仅回复不再被等待）；renewal/token 持久化在 handler 内部完成，不受提前回复影响（issue 第 4 条 safeguard 保持）。
- `infoOf` 缓存层 `info(id, key)`（host.js L1893）：不穿 signal——命中无 I/O；miss 回填一次性，usage hook 的 signal 已覆盖实际 vendor 读数。
- `inTime` 另两个调用点（load L1313 / config hook L1336）：init 阶段，不可取消面，不传 ctl。

## 修复面

- host.go：`c.cancellable = method != "init"`（fetch/gatewayRequest 机制原样复用：callAborting → pumpCtrl 写 `abort {id}`）
- host.js：dispatcher 普通 RPC 登记 `rpcInflight` + abort 提前回复（`Aborted`）+ done()（pending 不再滞留）；handler 收 signal；usage → `auth.usage` 第三参 `{ signal }`；models hook options 带 signal，`listWait` deadline 经 inTime abort 同一 controller；caller 取消联动 abort
- testdata/stuck：usage hook + models hook 可注入 trace（$STUCK_USAGE/$STUCK_MODELS_TRACE/$STUCK_TRACE）

## 不确定项

- 报告者的宿主脚本 SHA-256 fixture 未逐字节复刻；等价面由三条真宿主测试覆盖（abort 写出/提前回复/signal 到双 hook）。
- 不认 signal 的插件任务仍会跑完（JS 无法强杀 promise），但不再滞留 RPC 的 pending、不再滞留调用方——与 issue 的「retaining pending work」主诉一致。
