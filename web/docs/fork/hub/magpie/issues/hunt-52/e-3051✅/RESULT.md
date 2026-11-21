# Issue 3051 — TestPluginPicksComeBackWithTheirList 负载下变红（固定 200ms 读取）

日期：2026-10-20。工作区：`/tmp/magpie-h35`，分支 `hunt52-e-plugin-picks-wait`，基于 upstream/main `dee5c9d7`。未推送、未发评论。

## 结论

maintainer 的诊断方向正确：测试在 `answers <- full` 之后用一个固定 200ms 窗口（原 `internal/provider/plugin_delisted_test.go:122`）既检查"列表完整后不会被马上再问"，又默认 picks 的恢复落在这个窗口内。列表的实际落盘发生在 loop 自己的 goroutine 里（`KeepPluginsListed` → `dropGonePluginPicks` → `dropGonePicks` → `store`），与窗口并发；负载高时 apply 超过 200ms，`Find` 读到旧状态，128-129 行断言变红——与 issue 里的失败输出逐字一致。

修法：按 issue 要求把两件事分开。"不会再问"的 200ms 负检查原样保留；picks 恢复改为有界轮询（25ms 步进、10s 上限，包内既有惯例，见 `claude_status_test.go` / `plugin_usage_test.go` / `retired_test.go`），等到状态后走原断言（逐字未动）。生产代码没有"列表已应用"的信号量可用，状态本身就是等待对象。

## 提交

- commit：`749a176f99e555fa2efacc7b0eb3e34d5be26fe9`（作者 ggbdpq <ggbdpq@gmail.com>，单提交，仅测试文件，+18 行）
- patch：`0001-provider-TestPluginPicksComeBackWithTheirList-waits-.patch`
- patch sha256 前 16：`55a1ffadb123d317`

## 证据

1. 单独跑修前不红（符合"只在负载下翻车"）：`-count=10` ok。
2. 本机造负载无法复现修前的红：烧 CPU 到 load ~60-73 跑 20 次全绿（maintainer 的现场是 ~400）。apply 只是一次小文件的读改写，200ms 在 load 几十时很难被超过。
3. 机制按 maintainer 提议的方式钉死（注入延迟替代 load）：
   - 旧形态 + 在 stub 收到答案与 loop apply 之间注入 300ms：**红**，输出与 issue 逐字一致 `full list again: picks [pool-a pool-b], set aside [qoder/claude-x kiro/claude-y]`；
   - 新形态 + 同样 300ms：**绿**（轮询等到了 apply）。
   - 证明翻车根源就是固定窗口；轮询在构造上消除了它——读不可能发生在状态存在之前，因为它等的就是状态。
4. 修后压力：单独 `-count=10` 全绿；烧 CPU 到 load average ~340（接近 maintainer 的 ~400）`-count=10` 全绿。

## 验证矩阵（darwin/arm64，go 1.26.8）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 目标测试修后单独 ×10 | `go test -count=10 -run 'TestPluginPicksComeBackWithTheirList$' ./internal/provider/` | ok（2.744s），exit 0 |
| 目标测试修后负载 ×10 | 同上 + 4×ncpu 个 `yes` 烧 CPU（load ~340） | ok（2.764s），exit 0 |
| 目标测试修前单独 ×10 | 同上（改动前） | ok（2.717s），exit 0 |
| 目标测试修前负载 ×20 | 同上（load ~60-73） | ok（5.144s），exit 0 |
| 修前 + 300ms 注入 | 注入后 `-count=1` | FAIL：`plugin_delisted_test.go:130`，issue 原文失败输出（行号 +1 因注入行） |
| 修后 + 300ms 注入 | 同上 | ok（1.709s） |
| 全包 | `go test -tags nogui -count=1 ./internal/provider/` | ok（102.089s），exit 0 |
| gofmt | `gofmt -l internal/provider/` | 空（干净） |
| vet ×3 | `go vet -tags nogui ./internal/provider/`（darwin/linux/windows） | 全 OK |
| build ×3 | `go build -tags nogui ./...`（darwin/linux/windows） | 全 OK（darwin 有一条 `internal/gui/trayimage_darwin.go` 的 cgo 警告，预存，与本改动无关） |

## 不确定项

- maintainer 的 load ~400 现场未在本机复现（本机最高 ~340；修前在 ~60-73 下 20/20 全绿）。红的复现靠注入 300ms 完成，机制等价：都是"apply 晚于固定窗口"。
- 轮询上限 10s/25ms 是按包内惯例取的值；没有在真实的 load ~400 机器上实测过等待分布（但轮询语义只取决于"最终会应用"，与时长无关，超时则按原断言原样报红）。
- Windows / 交叉编译仅 build + vet，未运行测试（与本仓库矩阵惯例一致）。

## 产物

- `RESULT.md`（本文件）
- `3051-comment.body.md`（英文，可直接发；已 grep 确认零中文）
- `0001-provider-TestPluginPicksComeBackWithTheirList-waits-.patch`（format-patch，`git am` 可用）
