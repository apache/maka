# 4769 Kiro CLI library sync — 执行记录（2026-11-01）

issue: https://github.com/yetone/magpie/issues/4769 （ump45nose，11-01，0 评论）
take: https://github.com/yetone/magpie/issues/4769#issuecomment-6557414033
交付帖: https://github.com/yetone/magpie/issues/4769#issuecomment-6557500600（GET 回读通过：author ggbdpq，Attribution/patch/branch/head 全在）
分支: fix/4769-kiro-library-sync @ ggbdpq/magpie，head f8de12fa1a69781a84847ee54bccadd84808900b
patch: kiro-4769.patch，SHA-256 前 16 c33f6986474c9901
开工 SHA: 9d08993c8bd40de5d002bc364a16be344c5d78fa；POST 门禁 upstream 零新提交

## 诊断（假设 → 结论）
- H1 成立：library.apps() 只有 Claude Desktop，targets = agent.All + apps()。Kiro CLI 不在 agent.All（正确，magpie 不给它接模型）。
- 检测设计：apps() 里以 provider.KiroExecutable() != "" 为成员闸，条目 Bin 放 KiroExecutable 返回的完整路径 → agent.Detected() 经 binAt→LookPath 直接验证该路径，恰好等价于"二进制存在"，规避 Detected() 只查 PATH 的漏检（~/.local/bin 不在 GUI PATH、Kiro CLI.app）。
- "~/.kiro 不作检测依据"由成员闸 + 条目不设 Dir/Path 双重保证；~/.kiro 下的写入路径（skills/settings/steering）合法。
- 9e3ed461（#1448）是 gateway 域工具命名空间，仅 Kiro 关键字重合，不同域无碰撞。

## fmtKiro 格式（kiro.dev/docs 三页 2026-11-01 核实）
- encode：command/args/env 或 url/headers，无 type；SSE 在 supports 拒绝（errNoSSE 名单 + 注释补 Kiro CLI）。
- decode：url 恒读 streamable HTTP（文档无 SSE 命名方式），自设 case 不入 default 组。
- owned：transport/url/headers/command/args/env（disabled/autoApprove/disabledTools/oauth 归用户）。
- refsOf：refDollar/refDollar（${VARIABLE_NAME}，Kiro 按 Mcp Approved Env Vars 扩展）。
- key() 走默认 mcpServers。

## 测试（internal/library/kiro_test.go，in-package）
- TestKiroCLITarget：三路径 + Takes 三 kind + instructions/skills 端到端落盘
- TestKiroCLINotByItsFolder：KiroExecutable 桩 "" + ~/.kiro 有 crew/settings/steering → 非 target
- TestKiroMCP：无 type/transport 写出、用户字段保留、${NAME} 透传、sse 拒 errNoSSE、url 读回 http、幂等 sync、移除后用户条目无损

## RED / GREEN / 消融（原文摘要）
- RED（分支父提交）: `internal/library/kiro_test.go:97:22: undefined: fmtKiro` → build failed
- GREEN: TestKiroCLITarget PASS 2.08s / TestKiroCLINotByItsFolder PASS 0.02s / TestKiroMCP PASS 0.13s
- 消融（仅回退 targets.go 产品改动，mcp.go/envref.go/测试保留）:
  `--- FAIL: TestKiroCLITarget kiro_test.go:25: kiro-cli is not a target: [claude codex ...]`
  `--- FAIL: TestKiroMCP kiro_test.go:95: kiro-cli has no MCP target: <nil>`
  恢复后回绿 → targets.go 注册为承载性改动

## 验证矩阵
- 定向三测 PASS；改动包全量 `go test -tags nogui ./internal/library` ok 69.447s（无预存红）
- gofmt -l internal/library 干净；vet -tags nogui darwin/linux/windows 全过
- go build -tags nogui ./... 三平台全过（darwin cgo 警告为 dockflap/trayimage 预存，未触碰）

## 兄弟面（rg 全查结论）
- encode 无 type 组（fmtCursor/fmtDesktop/fmtZed、fmtPiNative/fmtGrok）：形状相同但各有文档注，fmtKiro 自设 case 带引用，未并组
- decode fmtHermes/fmtKimi/fmtDevin/fmtAlma 组读 transport:sse → 不入组（Kiro 文档无 SSE 命名）
- errNoSSE 名单/注释、owned 表、refsOf、apps()/targetOf 均已同步；WSL/项目级（.kiro/…）出范围未动

## 不确定项
- 真实 Kiro CLI 未装机实测（帖中 Not verified 已如实标注）；格式依据官方文档与 issue 报告人引用
- 车道规则：同机 5 车道只跑了定向+改动包，未跑全仓
