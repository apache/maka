# hunt-123 / issue #3208 交付元数据（3208-go-xnet-bump）

- 日期: 2026-11-05
- issue: yetone/magpie#3208（AgentWings: go 1.26.8→1.26.10 + x/net v0.56.0→v0.60.0）
- 原提交: 64dfe5d98a425f54a74be55f3bcd62e2473a9e36（AgentWings fork 已 404，从 yetone/magpie 对象存储按 SHA 取回）
- 应用提交: 41fe4e356d223fc6fdb8f1f668ed9651848d3a23（worktree /private/tmp/mg123-am，分支 fix/3208-go-xnet-bump，基 upstream/main 8b902e287，已推 ggbdpq/magpie）
- 作者保持: Shengming Liang <231182611+AgentWings@users.noreply.github.com>；committer ggbdpq
- am 冲突解法: git am -3 冲突（go.mod/go.sum）→ checkout --ours 后重跑 go get go@1.26.10 golang.org/x/net@v0.60.0 && go mod tidy（与 issue 自述复现命令一致）；tidy 附带 h265/jsonschema 由 indirect 转 direct（main 漂移所致，机械产物）
- patch 文件: 0001-go-Go-1.26.10-and-x-net-0.60-close-the-net-http-TLS-.patch
- sha256 前 16: 0ee3d99246149757
- govulncheck -tags nogui ./...（darwin/arm64, go1.26.10）: 修复前 13 affected → 修复后 2 affected；闭环 11 条（6617/6612/6611/6609/6608/6613/6610/6605/6607/6809 + 6603）；残留 6860（需 x/net v0.62.0）、6222（需 x/image v0.45.0）均在补丁范围外且晚于报告者扫描；5841/6866 仍在但未调用
- 验证矩阵: build darwin PASS / CGO=0 nogui build PASS / vet nogui PASS（仅 internal/gui cgo 预存告警）/ test nogui 三大包全绿（gateway 737.6s, provider 143.5s, cli 53.6s）；全量 ./... 未跑
- 背书帖: https://github.com/yetone/magpie/issues/3208#issuecomment-6638219302（GET 回读 17 项核验全 PASS）
- 预存红对照: TestMothX / TestLaneLimitRoutes / TestProxyCheckSaysAProxyPassedBy 均未出现
