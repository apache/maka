# hunt43 · #2642 改名写入者（稳定 id 匹配）——执行留档

- 分支：`hunt43-a-compaction-writer-id`（worktree `/tmp/magpie-5`，基线 upstream/main `ec7f4743`；首版基于 `ccb2eea1`，上游再进 4 提交后 rebase，本单区域无语义重叠）
- 提交：`b134d8bc`（单提交，作者 ggbdpq <ggbdpq@gmail.com>；rebase 前为 `55dfa76c`）
- patch：`0001-gateway-provider-a-conversation-s-compaction-writer-.patch`（SHA-256 前 16 `2e563c70fbc55d4c`）
- 状态：**本地待发布稿，未推送、未发帖**（推送/发帖须用户当轮授权）

## 判定链（与根因分析文档 docs/unsorted/magpie-2642-root-cause.md 对应）

1. 报告者 v0.1.1285 截图命中 `checkpointGone` 兜底分支（native_compaction.go:448 一带）「X is no longer signed in to magpie」= `provider.Logins(agent)` 里无同名账号。
2. RED 复现（探针+测试双证）：把写入账号按 `writeLogins`/`codexName` 的真实规则改名（`email · Team · <ws>`，id 保留）后，tip 上复现**与截图逐字同形**的报错。
3. 根因两层：
   - 匹配层：`checkpointReaders`/`checkpointGone` 均按显示名匹配，名字一变即失配（分析文档 §3-C 假设 C 成立）。
   - **新发现的生产级 bug**：`liveLogin("codex")` 返回记录不带 ID，`upsertLogin` 的 `ls[i] = l` 整体替换保留了 Order/On/Paused 唯独丢 ID → `writeLogins` 按新名重盖 standin → #905「kept through renames」对 live reconcile 路径失效（改名必丢 id）。探针证据：pre-rename `LoginID(renamed)`="67ac9ce846c37fb7"（standin）、post-rename 同调用="writer-id"→被 reconcile 改写后变 "67ac9ce846c37fb7"。claude 路径同受影响（`claudeSignInOwner` 也不带 ID，但 `upsertLogin` 一行修复对两者同时生效）。
4. E1（真实账号验证密文可否跨账号读）未做——无真实账号，属维护者/报告者侧，发帖中如实声明。

## 验证矩阵（全部实测，退出码 0）

| 检查 | 命令 | 结果 |
|---|---|---|
| RED（基线） | `go test -tags nogui -count=1 -run 'TestNativeCompactionWriterRenamed' ./internal/gateway/` @ccb2eea1（rebase 前） | FAIL 400「me@example.com is no longer signed in to magpie」+ FAIL 诊断断言 |
| RED（基线） | `go test -tags nogui -count=1 -run 'TestLoginIDKeptThroughALiveSignIn' ./internal/provider/` @ccb2eea1（rebase 前） | FAIL `the sign-in moved the id: ""` |
| GREEN | 同上两命令 @b134d8bc（rebase 后复跑） | ok（1.880s / 1.235s） |
| provider 全量 | `go test -tags nogui -p 2 -timeout 30m -count=1 ./internal/provider/` | ok 74.657s（rebase 前）/ 70.093s（rebase 后） |
| gateway 全量 | `go test -tags nogui -p 2 -timeout 45m -count=1 ./internal/gateway/` | ok 328.238s |
| 定向族 | `-run 'TestNativeCompaction|TestCheckpoint|TestCodexCompact|TestCodexOwnModelCompaction'` gateway | ok |
| race | `go test -race -tags nogui -run 'TestNativeCompactionWriterRenamed|TestLoginID'` 两包 | ok |
| gofmt | `gofmt -l internal/gateway/ internal/provider/` | 空 |
| vet ×3 | `go vet -tags nogui` 两包，darwin / GOOS=linux / GOOS=windows | 干净 |
| build ×3 | `go build -tags nogui ./...` darwin、linux；`GOOS=windows go build` | ok（darwin 已知 trayimage cgo 告警，预存） |

## 消融与 mutation

- 三产品文件（native_compaction.go / gateway.go / logins.go）回退基线、保留测试 → 三测全红（复现输出与 RED 一致）。
- 仅 logins.go 回退 → gateway 改名测试红（id 被丢）+ provider 测试红。
- native_compaction.go / gateway.go 为签名耦合切片（单独回退=编译错），行为面由 mutation 补证：
  - 摘 `isWriter` id 分支 → `…RenamedStillGetsItsConversation` 红；恢复绿。
  - 摘 `checkpointGone` id 匹配 → `…RenamedSaysSwitchedOff` 红（报「no longer signed in」）；恢复绿。

## 兼容性

- 旧记录（无 `id` 字段）：`cp.ID == ""` → 全部落回名字匹配，行为与现状一致；新版 magpie 读旧记录、旧版读新记录均安全（JSON omitempty）。
- 真被退出/移除的账号：行为不变（名字匹配失配且 id 不在登录表 → 兜底报错，文案已由 1280 的 checkpointGone 分状态）。

## 未跑什么

- 真实 ChatGPT 账号中途改名的现场（测试以 fixtures 构造改名，id 按 writeLogins 实际盖章规则携带）。
- E1 密文跨账号可读性（无真实账号）。
- GUI（无 GUI 文件改动）。
