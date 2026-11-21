# hunt49-a · yetone/magpie#2965 · TestRequestBuildsProvidersOnce 负载下偶红

日期：2026-10-19。工作树 `/tmp/magpie-h20`，分支 `hunt49-a-builds-once`，基线 upstream/main `79160455`。

## 结论

已修复并提交：`d71367984e0fad098e84c355f6904f4d2b9cd4e0`（单提交，test + provider 钩子两个文件）。patch sha256 前 16 位：`a1b8006fabe90a8a`。

按维护者在 issue 里点名的方向 (a) 修复：**判定依据改为"build 在何时被请求"（钩子记录的时间戳），而不是"请求在何时开始"**。测试断言的契约不变（一秒内的下一个请求不重建；请求内多次重建仍然红），只是把 900ms 这个对机器速度的猜测删掉，不再有假红。

## 根因（与维护者诊断一致）

- 测试在 `post` 之前取 `time.Now()` 作 `start`，request 2 只有在 `start` 距 request 1 的 `start` 900ms 内才允许 want=0；
- 但生产侧的 hold 按"构建被请求的时刻"判过期：`heldOf` 里 `time.Since(h.at) >= heldFor`（1s）就重建；
- 负载下 request 2 可以 850ms 才开始（走 want=0 分支），而真正到达 build 时 hold 已过期 → 生产正确地重建 → want 0 got 1 → 假红。

## 改动

1. `internal/provider/provider.go`：`allProviders` 在计数的同时记录被请求的时刻 `AllBuiltAt`（atomic.Int64，UnixNano；`AllBuilt` 旁边，注释写明用途 #2965）。新增 `time` import。这是唯一的生产文件改动，一行存储 + 一个导出变量，风格沿用现有 `AllBuilt`（"for tests"）。
2. `internal/gateway/request_builds_once_test.go`：删掉 `first/start/900ms` 分支；request 2 的重建仅当 `got == 1 && 记录的 ask 距首次 build 的 ask >= 1s` 时放行（hold 按它自己的钟正确放行）。ask 早于 1s 就重建、或一次请求建了 2 次（#2502 类 bug）仍然红。i==2（写后重建）保持严格 want=1。

判据吻合性论证：生产在 `heldOf` 进入时判 `at2' - h.at1 >= 1s`（h.at1 是 build 1 存储时刻 > ask1；at2' ≤ ask2 是进入时刻）；测试放行条件 `ask2 - ask1 >= 1s` 恒 ≥ 生产重建条件，所以"生产重建 ⟹ 测试放行，生产不重建 ⟹ got=0 want=0"。构造上不可能假红，也不会放过 hold 存活期内的错误重建。

## 复现证据（诚实地：本机没复现负载红，用构造法证明）

- 空闲机（Apple silicon 12 核，load ~5–7）先跑基线：`-count=8 -run 'TestRequestBuildsProvidersOnce$'` 8/8 绿（与 issue 里"单独跑必绿"一致）→ 本地无法复现负载红。
- 构造法：临时改 `holdcatalog.go`（实验用，未提交），第 2 个及以后的请求在取 hold 前睡 1.2s——即 request 2 在 ~60ms 开始（900ms 窗口内）但 ~1.26s 才到 build（hold 已过期），正是 issue 的场景。
- 上游原测试 + 注入：**红**，`request_builds_once_test.go:40: request 2 built the providers 1 times, want 0`（issue 里没抓到的失败行补上了）。

## 消融

只回退测试文件（钩子保留、注入保留）→ **再红**（同一失败行）；恢复新测试 → 绿。证明守门的是新测试形态，不是钩子本身。

## 验证矩阵（全部实际执行）

| 项 | 命令 | 结果 |
|---|---|---|
| 修复后单测 | `go test -tags nogui -count=8 -run 'TestRequestBuildsProvidersOnce$' ./internal/gateway/` | ok（8/8，1.048s） |
| 竞态 | 同上 `-race -count=4` | ok（4.347s） |
| 注入下新测试 | 注入保留时 `-count=2` | ok（6.802s，issue 场景被正确放行） |
| gateway 全包 | `go test -tags nogui -count=1 ./internal/gateway/` | ok（446.507s，exit 0） |
| provider 包 | `go test -tags nogui -count=1 ./internal/provider/` | ok（78.281s） |
| gofmt | `gofmt -l internal/gateway/ internal/provider/` | 干净 |
| vet | `go vet -tags nogui ./internal/gateway/ ./internal/provider/`，darwin/linux/windows | 全过 |
| 构建 | `CGO_ENABLED=0 go build -tags nogui`，darwin/linux/windows arm64 | 全过（构建产物已删） |

## 不确定项

- 维护者的负载环境（load ~280–400）本机未复现；证据是注入构造（ask 落到 hold 外、请求开始留在 900ms 内），不是真实负载数据。
- CI 机器、Windows 运行时未试。
- `AllBuiltAt` 是导出的测试钩子（沿 `AllBuilt` 先例）；若维护者更倾向方向 (b)（freeze/hold 缓存的钟，仿 2c3c9039 的 rpmNow），需要给 provider 加跨包时钟钩子，改动面更大，未走那条路。

## 产物

- 分支 `hunt49-a-builds-once`，提交 `d71367984e0fad098e84c355f6904f4d2b9cd4e0`（author/committer 均 ggbdpq <ggbdpq@gmail.com>），未 push、未评论。
- `0001-gateway-TestRequestBuildsProvidersOnce-judges-the-bu.patch`（format-patch，sha256 前 16：`a1b8006fabe90a8a`）
- `2965-comment.body.md`（英文 post-ready，已 grep 确认零中文，含完整 patch）
- 本文件。
