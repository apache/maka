# #3061 TestQueueFullAndWaitedOut 状态断言稳化 — 最终报告

日期：2026-10-20（本地）/ worktree `/tmp/magpie-h48`，分支 `hunt53-h-queue-full-state`，base `318697dc`

## 产物

- commit：`19cd883b5e34945e2879a09d522e6cd43c5844ad`（head 前 7-9：`19cd883b5`）
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt53/3061-queue-full-state/0001-gateway-TestQueueFullAndWaitedOut-judges-immediate-b.patch`
- patch sha256 前 16：`020c64ae0f6ec81f`
- 英文帖：同目录 `issue-body.md`（内嵌 patch 已与 .patch 文件 diff 校验，仅文件尾换行差异）
- commit message：同目录 `commit-message.txt`；全包日志：`gateway-full.log`

## 三条假设结论

1. **等价性 — 成立**。b 的 1s QueueWait 自入队起计时；c 的 429 在手时 `lane().Waiting == 1` ⇔ c 未等 b 出队就被拒；`len(v.seen()) == 1` ⇔ c 未到 vendor。即维护者点名的「c was answered before b left the queue（Waiting still 1, vendor asked once）」。
2. **竞态 — 直接读，不用 within**。c 队满即拒、不入队，其拒绝不伴随 lane 计数变化；b 入队已由前置 `within(Waiting==1)` 锁定。回复读到手后直接读 `lane()`；残余竞态仅「读回复→读 lane」间 b 恰好超时（<50ms 窗口 vs 原墙钟的全路径 900ms 窗口），且若 b 真已出队，红是正确红（场景前提已破）。
3. **墙钟取舍 — 完全去掉**。按维护者 "instead of a wall-clock bound" 与任务默认；注入 950ms 状态成立（b 的 1s 未到），注入 1.2s 状态断言红（正确红，见消融）。

## 注入位置与 RED

注入位置：`g.send(c)` 之后、`g.reply()` 之前 `time.Sleep(950ms)`（模拟调度慢、回复正确；实验性，未进 commit）。测试其余不动（upstream/main 原样）。

RED 原文（exit=1，`/tmp/magpie-h48-red950.log`）：

```
    concurrency_account_test.go:170: c = {tag:c body:{"error":{"code":null,"message":"slow: 1 requests at once is its limit, and its queue is full (1 waiting); try again shortly","param":null,"type":"rate_limit_error"}}
         status:429 header:map[Content-Length:[167] Content-Type:[application/json] Date:[Tue, 20 Oct 2026 15:49:46 GMT] Retry-After:[1]] err:<nil>}, want an immediate 429 with Retry-After
--- FAIL: TestQueueFullAndWaitedOut (1.07s)
```

与 issue 中失败信息一致（仅行号 169→170 为注入行所致，Date 为本机时间）。

## GREEN

墙钟断言换成两条状态断言（`lane().Waiting != 1` → Fatalf "want b still in the queue…"；`len(v.seen()) != 1` → Fatalf "want a alone"），删 `began`。保留 950ms 注入时：PASS（b 未超时，状态成立）。去注入后定向 `-count=5`：5/5 PASS。

## 消融

1. **还原消融**：还原=upstream/main 原测试（墙钟）+950ms 注入，即步骤 RED 的状态，红（上文原文）；恢复修后形态 `-count=5` 绿。
2. **辨别力消融**：修后 + 1.2s 注入（b 已出队）→ 红，exit=1（`/tmp/magpie-h48-disc1200.log`）：
   ```
   concurrency_account_test.go:175: lane after c = {Busy:1 Waiting:0 Limit:1}, want b still in the queue when c's 429 arrived
   ```
   去注入复绿。

## Watched 三查

(a) **永真化**：把新断言失败条件改为永假（`l.Waiting < 0`）+ 1.2s 注入 → 测试仍红，但红点从 :175（新断言）后移到 :194（d 的 queue-full 断言）：b 出队后队列有空位，d 不再被队满拒而是自己入队等满 1s（`d = 429 ... this one waited 1.0s for a free slot`）。结论：新断言是该破坏场景的第一道、最贴语义的拦截；即使拿掉它，测试也在下游红，不假绿（第一次误把方向写成 `>= 0` 永真 Fatalf，已修正并如实记录于 tautology 日志两份）。已还原。
(b) **同文件/同族墙钟清单**：lane/queue 族（concurrency_account_test.go、concurrency_test.go）内本处是唯一墙钟上界；同文件仅 :303 `time.Sleep(50ms)`（TestFullMemberGivesWay 的传播 settle sleep，非上界断言，Left）；族外相近：overload_test.go:122（`>3s` Retry-After patience，Left 建议维护者）、rpm_test.go:526、classify_test.go:292/485、first_token_test.go:63/132、retry_test.go:246、upstream_h2_silent_test.go:176、stream_error_open_test.go:93（均 Left，不扩修）。
(c) **lane() 缺 key**：`Server.Lanes()`（concurrency.go:268-276）返回新建 map，缺 key 取零值 `Lane{}` → `Waiting 0` → 断言红并打印 `{Busy:0 Waiting:0 Limit:0}`，不 panic。

## 矩阵（全部 exit=0）

| 项 | 命令 | 结果 |
|---|---|---|
| 定向 | `-run TestQueueFullAndWaitedOut -count=10` | ok 10.78s |
| race | `-race -count=3` | ok 4.70s |
| 负载 | 4×`yes>/dev/null` + `-count=20`（12 核 arm64，load 前 3.87/后 5.51） | ok 20.83s |
| 全包 | `./internal/gateway/ -count=1 -p 1 -timeout 30m`（后台） | ok 355.39s，0 FAIL |
| gofmt | `gofmt -l <测试文件>` | 空 |
| vet | `go vet ./internal/gateway/` | 干净 |
| build | darwin/arm64；linux/amd64 `-tags nogui`；windows/amd64 `-tags nogui`（另跑过 windows/arm64 亦过） | 全过（darwin ld warning 预存噪音） |

## commit

身份核对 `git config user.name user.email` = `ggbdpq` / `ggbdpq@gmail.com`。`git commit -F commit-message.txt`，首行 `gateway: TestQueueFullAndWaitedOut judges "immediate" by the lane's state, not the wall clock (#3061)`，正文 What changed / Run，`Fixes #3061`，尾注 `Generated-by: GLM-5.3-Flash (ZCode)`。

## 不确定项 / 未验证

- issue 的 load ~380 真机不可复现；负载模拟（load ~4-6）远温和于 ~380，修后在那种极端下的稳健性靠机制论证（状态读替代时钟）而非该负载实测。
- 分支未 push，CI 未跑。
- 第一次永真化实验方向写反（`>= 0` 永真触发 Fatalf），已修正为失败条件永假（`< 0`）并重跑；两份日志均留存（tautology1200.log / tautology1200b.log）。
- issue-body.md 内嵌 patch 与 .patch 文件仅文件尾换行差异（正文逐行一致），sha256 以 .patch 文件为准。
