# 4978 rework：E2BIG 捕获（维护者指路，2026-11-06）

## 形态结论

维护者 yetone 末评（id 6670564403）否定静态 bound（含按 OS 分界的静态 bound——"Don't guess the
bound"），指路：`errors.Is(err, syscall.E2BIG)` 从 `run.launch()` 捕获（每 OS 都对），
答案首选同一 turn 降级 claude -p（safeguards 走 stdin），其次 tuiRefusal 带尺寸；并覆盖
--json-schema 兄弟面；用 fake launcher 返 E2BIG 写 main 必红测试。任务书"按 OS 分界/runtime.GOOS"
系对驳回理由 1 的概括，被原文否定；E2BIG 方案同样满足必守判例（Linux 每轮必死被拦下并降级，
macOS 128KB~1MB exec 成功不受影响），经主线程确认按原文实施。

## 改动（head e8ca5da45，基线 upstream/main 4ef47b3f4）

- `startRun` launch 失败路径：`errors.Is(err, syscall.E2BIG)` → TUI 面 `kept=true` +
  `req.tuiEnvTooBig=true` 递归 `startRun`（claude -p，code `extra-body` 新入 claudePrint 理由表与
  通行码集合）；-p 面 `execTooBig`（新类型，400 族，消息带 cliSchema 字节数）。
- `serveSubscriptionAs` 错误映射加 `execTooBig`→400；`start()` saved-session 整对话重试排除
  `execTooBig`（同 cliSchemaRefused 类，尺寸不变重试无意义）。
- `startTree` var 缝（launch 的 proc.StartTree，同 claudeEuid 惯例）供 fake launcher 测试。
- ir.go Request 新字段 `tuiEnvTooBig`（同 tuiRefused 家族）。
- 子系统文档 interactive-mode 节补"第二例外"段。

## 测试（claude_e2big_test.go，两测 main 上行为红已实测）

- `TestClaudeTUIEnvTooBigRunsAsPrint`：fake 拒 helper exec → 200，唯一 run 是 -p，
  log 有 apply_flag_settings+classifier_context（stdin 交付）且环境无 EXTRA_BODY。
- `TestClaudePrintSchemaTooBigRefused`：fake 全拒 + output_config schema → 400 带字节数、
  retryable=false、零 run。
- RED 实测消息：`502 fork/exec …/magpie: argument list too long`（与报告者症状逐字同）。

## 验证矩阵（2026-11-06，darwin arm64，GOCACHE=/tmp/mg-4978-gocache）

| 项 | 结果 |
| --- | --- |
| 全量 `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok 800.1s 零失败（预存红 TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy 本轮未触发） |
| `TestClaude*` 全族 | ok 130.9s |
| 定向 -race（新测试+safeguards/refusal/schema-refused/room 族） | ok 4.4s |
| gofmt -l internal/ | 净 |
| go vet -tags nogui ./internal/gateway（darwin 与 GOOS=linux） | 净 |
| build：darwin ./...、GOOS=linux gateway+claudetui、GOOS=windows gateway | 全 ok（syscall.E2BIG windows 可编译） |
| 消融（仅摘 startRun E2BIG 捕获块，seam/type/映射保留） | 两测双红，消息同上；恢复双绿 |

## 兄弟面 rg 全查（proc.StartTree / proc.CommandContext 全调用方逐个对比）

| 站点 | 改/不改 | 理由 |
| --- | --- | --- |
| gateway `run.launch()`（订阅 run） | 改 | 唯一 exec 串随请求增长的站点（TUI env 注入 + --json-schema），两面全覆盖 |
| gateway `start()` saved-session 重试 | 改 | execTooBig 排除，避免同尺寸重撞 |
| gateway warmup（tuiCommand 两处、`-p /usage`） | 不改 | 参数/环境为常量，无请求可控串 |
| provider/install.go:127 | 不改 | 操作员安装脚本，非请求路径，失败自有显式错误 |
| library/mcp_run.go:439、mcp_check.go:629 | 不改 | 用户 MCP 配置面非请求面，启动失败已是显式路径 |
| wslrun（WSL 订阅 run） | 不改（被同一 catch 覆盖） | 大 env 不跨 wsl.exe argv（wslrun.Env 按名单传递），真拒时同被 launch 的 errors.Is 接住 |
| 其余 proc.CommandContext（omarchy/update/plugin 等） | 不改 | 与请求内容无关 |

## 发布

- 推送：`git push origin e8ca5da45ce20ad3aab838b229ba167739528933:refs/heads/fix/4978-arg-bound-goos`，
  ls-remote 比对一致。
- PATCH 帖：<https://github.com/yetone/magpie/issues/4978#issuecomment-6685771850>
  （"Rework per @yetone's review" 引末评 → 修法 → ```text 围栏 patch → 分支链接+head sha+sha256
  前16 `9ff90b169f47986b` → 验证表 Not verified 首位 → Attribution → 尾注）。
- GET 回读：user=ggbdpq，围栏成对，围栏内 patch 与本地 16302 字节逐字节一致（GitHub 仅补一个尾换行）。
- Not verified（留报告者）：Linux 真机过界拒绝→降级 -p 实测（phylipppp-zzy v0.1.2888 会话即样本）；
  macOS 128KB~1MB 会话交互模式不受影响实测。
