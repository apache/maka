# #5518 车道产物：Antigravity GOAWAY too_many_pings

- 单：yetone/magpie#5518（OPEN；报告者 hj-smith 自带候选 patch——正文+两评全为报告者）
- 车道：M1 续派（hunt-20261106），upstream/main 基线 416305451
- 判定：**让位闸触发（报告者方案先行，两轮验证+本地安装）→ 出列转分析帖**（#2582 先例形态：候选归报告者，车道交独立复核+rebase 实证+碰撞矩阵）

## 独立核因（读码 416305451）

1. `netproxy.go:54` PingAfter=PingWait=10s；`HTTP2Health()`（:65-66）= SendPingTimeout/PingTimeout 各 10s。
2. gateway 的 antigravity 传输= `netproxy.Dispatch(vendorTransport(...))`（`upstream_transport.go:39-41`），HTTP2 配置=`netproxy.HTTP2Health()`（:78）——长静默流的连接被每 10s 健康探测 PING，Code Assist 边缘以 GOAWAY ENHANCE_YOUR_CALM "too_many_pings" 拒绝。报告者诊断成立。
3. `lostPing`（`upstream_transport.go:145`）只认 "http2: client connection lost"（Go 自身健康探测超时关连），对端 GOAWAY 不在其内——上传 retry-once 与新 landed 的下载 HTTP/1.1 重试都不接此错。

## patch 在当前 main 不净：1fd0bb967 冲突

- 报告者基线 94d4866b5，重验版 v0.1.3162=8c97edc80（已核实为 main 祖先）。
- 1fd0bb967（landed 2026-11-06 23:29 +0800，晚于报告者末评）在 RoundTrip 的 h1 表达式加了 `overHTTP1(req.Context())`——与 patch 的 RoundTrip hunk 冲突；`git apply` 失败，`--3way` 冲突一处。
- 解法=并集：`h1: ... || overHTTP1(req.Context()) || h2BrokenFor(req), ..., noPing: codeAssistHost(req.URL.Hostname())`。本车道已解出并提交 68e6afdb9（父=416305451），patch 存 `hj-smith-candidate-rebased-68e6afdb9.patch`。

## 本车道验证（rebased 树，darwin/arm64 go1.25.5）

- `go test -tags nogui -count=1 ./internal/netproxy/`：ok 4.9s——报告者两新测试 + 1fd0bb967 四测试（TestDownloadBrokenOverHTTP2TriesHTTP1/TestOverHTTP1EveryHost/TestAgainOverHTTP1/TestBrokeOff）全绿，零碰撞。
- 定向 -v：TestCodeAssistDoesNotSendHealthPings（6 子测：双 host×全局/显式 direct+大小写/尾点）PASS；TestCodeAssistPingPolicyLeavesOtherHostsAlone PASS。
- 消融（字段型：只摘 RoundTrip noPing 赋值+transport 克隆 hunk，保留 codeAssistHost——整文件回退则测试不编译）：TestCodeAssistDoesNotSendHealthPings FAIL（"Google stream still gets health pings: SendPingTimeout:1s"），host 匹配测试保持绿。RED→GREEN 因果证实。
- `go vet -tags nogui ./internal/netproxy`：darwin+GOOS=linux 干净；`go build ./...` OK。
- gateway 定向（TestUpstream*/TestUpload*/TestH2*）：ok 8.0s。
- 未跑：gateway 全包 25m、-race、GOOS=windows（报告者已在 v0.1.3162 跑 Windows+vet+netproxy 包；两侧合并覆盖广但均非全矩阵）。

## 分析帖增量（报告者两评之外）

1. 1fd0bb967 不缓解本单 gateway 面：BrokeOff 虽已把 GOAWAY 归"断流"，AgainOverHTTP1 只接了下载（update/pii/Bun/claudecode/grok），gateway 生产码零调用（rg 核验）——候选 patch 仍是唯一在桌修法。
2. uploads 面：`uploadTransport` 同经 Dispatch（upstream_transport.go:41），Code Assist 双 host 的上传同样失去健康探测——报告者已接受的 tradeoff，帖中点名。
3. dead-path 家族（#2843/#4936）钉子全绿：netproxy 包（deadpath_test/http2_health_test）绿；gateway 包 patch 未触；base 传输配置被报告者测试断言不变。
4. 作用域核实：仅 cloudcode-pa/daily-cloudcode-pa 关探测；generativelanguage（Gemini/AI Studio）、Vertex、全部中转保持 10s 政策（负向测试钉住）。
5. 两侧共识未验面：真实长静默生产流（4.67s OK 仅证连通）。

## 帖与清理

- 分析帖：见 POST.md，URL 见帖后回填。
- worktree /private/tmp/mg-5518、分支 fix/5518-goaway-pings：帖后自清（候选 patch 留档在上）。
- 分析帖: https://github.com/yetone/magpie/issues/5518#issuecomment-6694022422
- take: https://github.com/yetone/magpie/issues/5518#issuecomment-6693859948
