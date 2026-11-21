# hunt115-c3-4576 — davsync: GitHub sync wedges on a slow line

- 单：yetone/magpie#4576（LingYingNX，2026-10-31，0 评论）。占坑评论：issuecomment-6556502922。交付帖：issuecomment-6556674822。
- 分支 `hunt115-c3-4576`（fork ggbdpq/magpie），head `e97601d65ed6d49f061fed3171d72398b111a324`，基线 `1fac66c06`；patch sha256 前 16 `5eea804af551685d`。
- 根因：`internal/davsync/stall.go` 的 watchdog 按 method 判定（GET/PUT 才 moving），其余一律 flat metaLimit 30s。GitHub 后端每个上传都是 POST（blobs 每片 16 MiB 文件 ≈ 21 MB base64，#2707 parts 机制），flat 30s 需 ~550 KB/s 上行；慢线下每次 run 同一预算从头重试同一片 → 确定性失败循环（非状态污染：sync-state.json 无卡死状态，重启/升级无效）。
- 修法：`bigBody(req)`（Body 非 NoBody 且 ContentLength ≥ 64 KiB）并入 moving 判定。meta 请求（trees/commits/refs PATCH/contents DELETE/PROPFIND 族，<4 KB）保持 30s 不变；64 KiB=16 倍最大 meta body 余量，30s 内只需 ~2 KB/s。
- RED：TestGitHubSlowBlobUploadIsNotCutShort 在父提交上 FAIL `Post ".../git/blobs": the server didn't answer in 300ms (POST)`（缩时沙盒，与 #4576 报错同构）；GREEN 0.87s。TestGitHubSmallPostKeepsTheLimit 两侧均绿（0.30s，保护小 POST 不被放开）。
- 消融：父提交 stall.go + 新测试 → 慢 blob 红/小 POST 绿；恢复 → 绿。变异点在 moving 判定行（语义分叉行）。
- 矩阵：davsync 包全量 nogui 34s ok；`-race`（Stall|GitHub 定向）81s ok；gofmt -l 净；vet（本地/linux nogui 全仓/windows 全仓）净；三平台 `go build -tags nogui` ok。
- 未跑：全仓 `go test -tags nogui ./...`（本机 5 车道并行限制，帖内 Not verified 已标）；Windows 真机慢线无法实测。
- 兄弟面 rg 全查：davsync 内非 GET/PUT 发送方 = blobs（大，修）/trees+commits+refs PATCH（<4 KB，不改）/contents DELETE（<200 B，不改）/usage DELETE（无 body，不改）/WebDAV/S3 PUT（已 moving）。syncClient 仅 github/dav/s3 三处消费。
- 测试基建坑两枚：narrowLine 的 client 无 githubTransport rewrite 层（会打到真 api.github.com）；httptest handler 不读 body 就看不到客户端断开（srv.Close 等 5s），挂起分支先 io.Copy 排干。
- POST 前门禁：upstream 推进 2 提交（usage #4372/#4737），无 davsync/stall 自修、不触本单文件，未 rebase。
