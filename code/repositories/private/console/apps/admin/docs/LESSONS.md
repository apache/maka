# Lessons

规则长自真实失败：每条教训 = 规则 + 为什么 + 证据（文件/commit/复现方式）+ Seen N×。
同一条教训在 3 个不同日期重现，升格为 AGENTS.md 必查项。
从第一条真实教训开始记，不预写占位条目。

## 活跃教训

### 逗号列表字段不能用 LIKE 前缀匹配（2026-10-10，Seen 1×）

- 规则：查 `ancestors` 这类逗号分隔的 ID 列表，用 `FIND_IN_SET(?, ancestors)`（与上游 DataScopeAspect 一致），不用 `LIKE 'prefix%'`。
- 为什么：`0,100,101%` 同时命中 `0,100,1015`，"本部门及以下"会把数字前缀相同的其他分支算进数据权限。
- 证据：`auth_guard.go` 的 `ResolveDataScope`。用临时库（mysql:8 + `RuoYi/sql/ry_20260319.sql`）设 `LILIYA_TEST_DSN` 运行 `go test -run TestResolveDataScope_SubtreeIgnoresSiblingPrefix -v .`；旧代码输出 `deptIDs = [101 103 104 105 106 107 1016], want [101 103 104 105 106 107]`。
- 附带发现：`TestResolveDataScope` 的清理语句会删除种子部门 100/101，不要对开发库 ruoyi-mysql 跑它；同一进程里排在它后面的库测试会读到缺失的种子数据。

### 被 handler 调用的共享 map 必须上锁（2026-10-10，Seen 1×）

- 规则：任何从 gin handler 可达、且跨请求共享的 map/切片，写入前加锁；`go test -race` 要有覆盖该路径的并发测试才算数。
- 为什么：gin 每个请求一个 goroutine，并发写 map 会 `fatal error: concurrent map writes` 直接崩进程，recover 救不了。
- 证据：`scheduler.go` 的 `Scheduler.ids`（jobs.go 四处 Reschedule）。运行 `go test -race -run TestReschedule_ConcurrentRequests .`；旧代码 3/3 次输出 `race detected during execution of test`。此前全量 `-race` 通过只因没有测试走到这里。

### 目录边界判断要带分隔符（2026-10-10，Seen 1×）

- 规则：判断路径是否在某目录内，用 `HasPrefix(p, dir+string(filepath.Separator))` 或 `filepath.Rel`，不能裸 `HasPrefix(p, dir)`。
- 为什么：`filepath.Clean("./upload")` 是 `upload`，裸前缀会放行同级的 `upload.go`、`uploadX/` 和目录本身。
- 证据：`upload.go` 的 `DownloadResource`。运行 `go test -run TestDownloadResource -v .`；旧代码输出 `resource "upload.go": served file (attachment; filename="upload.go"), want rejection`。
- 断言注意：被下载的源码里本身含有错误文案，只断言 body 包含文案会假通过，要同时断言没有 `Content-Disposition`。

### 请求体读取失败时必须中止后续处理（2026-10-10，Seen 1×）

- 规则：`GetRawData` 返回错误时不能继续用部分字节做 XSS 过滤、防重指纹或操作日志再放行 handler。
- 为什么：读取函数可能同时返回部分内容与错误；忽略错误会把截断请求当作有效写入。
- 证据：`xss.go` 的 `XssFilter` / `RepeatSubmit`、`logs.go` 的 `OperLog`。运行 `go test -run 'Test(XssFilter|RepeatSubmit|OperLog)_RequestBody' -v ./...`；旧代码的 interrupted 子测试输出 `response = accepted, want "code":500`，修复后返回失败包络并中止。
