# hunt63 Lane A · issue #2547 验证日志

- 分支：hunt63-a-2547-search-queue（worktree /tmp/magpie-r63-a，基线 ba1dc7f975666e50308ef7bf8173c8a8e91c553b = upstream/main）
- 提交：9700d630a4bfa7a9f6730907c46b2564b1e4ded7
- 身份：Author=ggbdpq <ggbdpq@gmail.com>，Committer=ggbdpq <ggbdpq@gmail.com>（git -c 覆盖后核验）
- patch：0001-tests-the-search-queue-s-idle-client-times-the-state.patch
- SHA-256 前 16：89dd3cbbf021c3db
- 改动面：internal/gateway/search_queue_test.go 单文件，+24/−3，纯测试

## 前提核验

- gh issue view 2547：正文签名 `search_queue_test.go:139: silent upstream covered indefinitely: pings=0 complete=false`，@63be47717 load ~250；yetone 10-19 评论 @c1e3afc24 load ~330-420 同签名，"I'm not working on it"。与本次基线代码对齐：:104 `idle := time.AfterFunc(300ms, cancel)` 在 `Do` 返回（收到响应头）后立即起表，:112 起只有 `data:` 行才 Reset。
- 机理确认：headers→首个翻译事件的链路（搜索翻译/队列/上游拨号/SSE 解码）在负载下可超 300ms → cancel 提前掐流 → pings=0 → :139 红。全静默 provider 下 `Do` 也能返回（keepalive_test.go:199-201 #2248 注释佐证 gateway 先发响应头），故「首 data 行起窗」无死锁风险，且 ：97 的 5s hard cap 是不说话流的兜底终止器。
- 注：首次 RED 构造曾把 sleep 插在起表之前导致计时起点被一并推迟、未跑红；已修正为「先按旧代码起表、hold 发生在计时进行中」。

## RED（确定性构造，非真实负载）

构造：新增 `proceed` 通道，上游 handler 在写 `response.created` 前 `<-proceed`；silent 子测试在 `Do` 返回、旧 300ms 窗起表后 `time.Sleep(500ms)` 再 `close(proceed)`。旧窗 300ms 必在上游被扣住期间（500ms）触发 cancel → pings=0。

```
    search_queue_test.go:148: silent upstream covered indefinitely: pings=0 complete=false
--- FAIL: TestSearchQueueKeepsCodexAlive (0.91s)
    --- PASS: TestSearchQueueKeepsCodexAlive/comments (0.20s)
    --- PASS: TestSearchQueueKeepsCodexAlive/progress (0.09s)
    --- PASS: TestSearchQueueKeepsCodexAlive/cancel (0.09s)
    --- FAIL: TestSearchQueueKeepsCodexAlive/silent (0.53s)
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.288s
```

（:148 = 插入注释/hold 后的同一断言，文本与 issue :139 逐字一致。）

## GREEN（修复 = 首 data 行起窗）

修复 hunk：删 headers 处 `idle := time.AfterFunc(300ms, cancel)`；循环内 `data:` 分支改为 `idle == nil → AfterFunc(300ms)` 否则 `Reset(300ms)`；`defer` 改守卫式 Stop。hold（sleep+close(proceed)）保留为回归锁。

```
go test -tags nogui ./internal/gateway -run TestSearchQueueKeepsCodexAlive -count=3 -v
--- PASS: TestSearchQueueKeepsCodexAlive ×3（comments/progress/cancel/silent 全绿）
ok  	github.com/yetone/magpie/internal/gateway	4.177s   （修复后首轮）
ok  	github.com/yetone/magpie/internal/gateway	4.047s   （提交态复跑）
```

## 消融（提交后执行）

仅回退计时 hunk 至父提交 ba1dc7f9 形态（headers 起表 + 裸 Reset），hold 保留；`git diff --stat`：1 file changed, 3 insertions(+), 15 deletions(-)。复跑（测试名取自 `grep -n '^func Test'`：TestSearchQueueKeepsCodexAlive）：

```
    search_queue_test.go:148: silent upstream covered indefinitely: pings=0 complete=false
--- FAIL: TestSearchQueueKeepsCodexAlive (0.90s)
    --- FAIL: TestSearchQueueKeepsCodexAlive/silent (0.53s)
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.257s
```

→ 回红，修复 hunk 是绿的唯一原因。消融后 `git checkout --` 恢复提交态，`git status` 干净。

## 验证矩阵（提交态 9700d630）

| 项 | 结果 |
| --- | --- |
| `go test -tags nogui ./internal/gateway -run TestSearchQueueKeepsCodexAlive -count=3` | ok（4.047s） |
| `go test -tags nogui ./internal/gateway -count=1` 包全量 | ok（338.588s，exit 0，后台任务 exec_5981fa90） |
| `go test -tags nogui -race ... -run 'TestSearchQueueKeepsCodexAlive|TestTranslatedStreamKeepsClientAlive|TestTranslatedSilenceStillTimesOut' -count=2` | ok（14.548s，exit 0） |
| `gofmt -l internal/gateway/search_queue_test.go` 及目录 | 无输出 |
| `go vet ./...` | exit 0；internal/gui 两条预存 cgo `-Wenum-conversion` warning（trayimage_darwin.go:112，与本单无关） |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `go build -tags nogui ./...`（darwin/linux/windows） | 三平台全过（darwin 同一条预存 warning） |

## Watched 三查

1. 人为打破看回红：消融即此项，回红（见上）。
2. 兄弟面（「客户端 idle 窗自响应头起计时」全仓仅三处）：
   - `search_queue_test.go:104` — 本单已改。
   - `keepalive_test.go:116`（TestTranslatedStreamKeepsClientAlive）— 不改：上游收到请求立即吐首事件，无搜索翻译链路，500ms 窗（注释明言给负载调度留余量）未观测到红；非本单范围。
   - `keepalive_test.go:210`（TestTranslatedSilenceStillTimesOut）— 不改：#2248 刻意让窗覆盖首字节，因为全静默 provider 除该窗外没有别的终止器（此测试无 hard cap）；语义与 search_queue（有 5s hard cap 兜底）不同，headers 起表在那里是设计而非病。
   - 其余 idle/watch 计时（patience.go watchEvery、keepaliveEvery/gap/longest、agentQuietMost、keepHeldAfter）均为产品侧数据驱动窗口，不涉及「窗先于状态启动」，不在面内。
3. 失败读取变成什么：真静默上游被无限掩护时，合成 ping 持续 Reset 窗 → 5s hard cap cancel → pings>12 或 complete 缺失 → 同一断言仍红；负载导致的 pings=0 假红消失。

## 不确定项

- 未在真实 load ~300+ 下复跑（本机不可控构造该负载）；确定性 hold 是等价构造，与其产生的失败相同（首数据晚于旧固定窗）。
- 静默窗内 gateway 自身合成 ping 的个数随调度在 1~若干浮动，断言 (0,12] 对此本就有余量，与基线行为一致。
