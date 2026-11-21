# #5505 验证矩阵（车道 N2，2026-11-06，worktree /private/tmp/mg-5505）

## 单况

- #5505「usage: a stream event over 1 MiB loses its usage…」reporter R1cK-ChaN（质量报告者，同日 #5504/#5517），OPEN，1 评论（其 fork 修支 88c97cfb2 自述）。
- 痛点确认：internal/gateway/sniff.go 两处 `1<<20`（write 的 runaway-line 帽、line 的 data 累积帽），源头 30c489a0（usage 页原始提交）。sse.go reader 本来就吃 32 MiB 行。两调用点（gateway.go 直通、codex_backend.go ChatGPT backend）均 32 KiB 分块直喂 sniffer，中间无截断。
- 排雷：无 PR 引用；`git log --grep 5505` 命中 7353a4bc2 系 529 行显示修复，与本单无关（方向鲜度排除）；issue 评论仅 reporter 自述。

## TDD

- 测试（internal/gateway/sniff_test.go）：
  - `TestSniffUsagePastOneMiB`：1 MiB+126 字节的 response.completed（echo tools 形状），32 KiB 分块写入（仿真实拷贝循环），断言 usage 三数+ended。
  - `TestSniffEventPastTheCapIsLetGo`：两个子测试。`a_whole_event_past_the_cap`：正常事件在前，32 MiB giant（独有数值 999999/888888）压轴——Usage.add 后者胜，去帽必红；`a_line_that_never_ends`：32 MiB+4KiB 无换行行，钉 runaway 分支的丢弃与恢复。
- RED：实现前（仅落惰性 const）TestSniffUsagePastOneMiB FAIL（usage 全 0=issue 症状），守卫测试绿（旧帽也放走，属预期）。
- GREEN：实现后 TestSniff 全绿（1.16s）。

## 消融（先提交 e53ef7291 后做，只动产品文件，逐个 restore）

- A：line 帽→1<<20：TestSniffUsagePastOneMiB FAIL（usage 全 0）✓红
- B：write 帽→1<<20：绿——真行为非漏守卫：行长仅超帽 126 字节时，跨界块内已含行尾，扫描消费后 buf 为空，帽不咬合；write 帽实际咬合条件=行长>帽+块(32KiB)，其价值在 never-ending 行的内存界
- C：const→1<<62（双帽实效关闭）：`a_whole_event_past_the_cap` FAIL（giant 数值 999999/888888 覆盖读出）✓红
- scanned 增量扫描为纯性能变异（无语义分叉），无断言可红，不设消融。

## 兄弟面

- `1<<20` 于 sniff.go 无残留；`sniffEventMost` 恒三引用（sniff.go 定义+两帽、sse.go scanner），单一概念单一定义。
- 两 sniff.write 调用点逐字节直达，无中间帽。
- 其余 IndexByte 累积器（chattidy/grok_*/reasoning_content/thinking_signature/toolsearch/claude_warmup/ollama_chat/sse_bare 等）为事件级 tidy 或自有小缓冲，非原始线缆帽丢 usage 面，不扩表不触碰。
- 8<<20 整 JSON 帽（非 SSE 路径）未动——issue 只报 SSE 路径。
- 失败语义保持：帽丢后 data/buf 置空重开，`event:` 名行仍置 ended（预存注释行为不变）。

## 矩阵

| 项 | 结果 |
| --- | --- |
| gofmt -l（sniff.go/sse.go/sniff_test.go） | 干净 |
| go vet -tags nogui ./internal/gateway/（darwin/linux/windows amd64） | 三平台 0 退出 |
| go build -tags nogui ./...（darwin/linux/windows amd64） | 三平台 0 退出 |
| 定向 go test -tags nogui -run TestSniff ./internal/gateway/ | ok（全 Sniff 族） |
| gateway 全包 -race 25m | 23m47s，唯一 FAIL=TestBrowserKeyOffClosesItsBrowser（DATA RACE，browser_key_test.go），dbaeaec12 干净基线同红（独立 worktree 实测）→ 预存；其余全绿含 Sniff 族 |
| 预存红对照 | TestMothX（internal/agent）、TestLaneLimitRoutes+TestProxyCheckSaysAProxyPassedBy（internal/gui）本 head 红；干净 dbaeaec12 基线同红（独立 worktree 实测）→ 预存非引入 |

## 交付终态

- 提交 amend 定形：f73f75258c22cc718bc132c677d8dae1040f641f（subject 无 #N，首段尾 (#5505)，含 Broken-by-hand 与 Run 节，尾注 Generated-by: GLM-5.3-Flash (ZCode)）。
- patch：0001-*.patch（format-patch --zero-commit），raw sha256 前 16 = a9f70212e7091d89。
- push：`f73f75258…:refs/heads/fix/5505-oversize-event` → ls-remote 回读同 sha ✓。
- PATCH 帖：comment-6688592143（15:32:33Z），GET 回读 11 关键字段全 OK，嵌入 patch 与磁盘字节一致。
