# #2813 settings 并发 setter 丢更新 — 本地记录

日期：2026-10-19　分支：`hunt45-a-settings-update`（worktree `/tmp/magpie-h4`，base upstream/main `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`）

## 结论

已完成：`settings.Update`（持 `fileMu` 跨 load→fn→save，镜像 `SetGatewayConversations`），三个被点名的 setter（`SetCodexCredits`、`setCodexAutoReset`、`setModelName`）迁上去，100 轮放大的并发守卫测试。未动其余 52 个函数（28 文件、81 个 Save 调用点），理由与完整清单见 comment 的 Siblings 节。

## 提交与产物

- commit：`ffbddc4e14a91d86818d7471a164e12d1bc221c8`，作者 `ggbdpq <ggbdpq@gmail.com>`，单提交，working tree clean
- patch：`0001-settings-a-settings-update-holds-the-file-s-lock-acr.patch`，sha256 前 16 位 `b4a014ea950c485b`
- post-ready 文：`2813-comment.body.md`（英文，已验证 0 个中文字符，含完整 format-patch 于 details/patch 栏）

## 改动面（file:line）

- `internal/settings/settings.go:1174` — 新增 `Update(fn func(*Settings) error) error`；fn 出错不落盘；走 `save(s, false)`（泛化保存不碰录音同意，`TestGatewayConversationGenericSaveCannotEnable` 语义保留）
- `internal/provider/codex_credits.go:36` — `SetCodexCredits`
- `internal/provider/codex_autoreset.go:122` — `setCodexAutoReset`
- `internal/provider/modelprefs.go:78` — `setModelName`（注意：见下"行为细微变化"）
- `internal/provider/codex_credits_concurrent_test.go` — 守卫测试 `TestSetCodexCreditsConcurrentKeepsBothAccounts`

## TDD 过程（诚实记录）

1. 第一版测试按 reporter 形状（单轮两 goroutine）：`-count=20` 只有 11/20 红（10 丢 a、1 丢 b）——本机安静时两个 goroutine 不一定重叠，属 flaky-red，不可接受为"必红"证据。
2. 放大为 100 轮独立账户对（每轮 start gate 同时放行两 goroutine，断言两账户都在）：base 上 `-count=5` 5/5 红，每轮丢 98–100/100；这才接近确定性。
3. GREEN：修后 `-count=20` 20/20 过（`ok ... 37.970s`，exit 0）。

## 消融

`cp` 四个产品文件到 `/tmp/h4-keep/` → `git show upstream/main:<path>` 还原 → `-count=5`：5/5 红，丢 100/99/100/99/95 轮 → 从 keep 恢复 → `-count=5` 5/5 绿（`ok ... 10.217s`）。

## 变异

- (a) Update 改为 load 后释锁、save 前再取锁（等价 Load/Save 语义）：`-count=20` 4/20 次失败，每次恰好 1/100 轮。**诚实说明**：该变异窗口远窄于原缺陷（Go mutex barging——解锁者常在唤起的 waiter 被调度前重新拿锁），测试能抓住它（exit 1）但每轮命中率仅 ~0.2%，弱证据。
- (b) `SetGatewayConversations` 未改动；settings 全包测试（含 `TestGatewayConversationConsentSurvivesStaleSettings` 等守卫）通过。

## 验证矩阵（全部实跑）

| 检查 | 结果 |
|---|---|
| `go test -tags nogui -count=1 ./internal/settings/` | ok 20.364s |
| `go test -tags nogui -count=1 ./internal/provider/`（全量） | ok 72.358s，零失败（无预存失败） |
| 守卫测试 `-count=20` | ok 37.970s |
| `-race` 守卫测试 | ok 3.367s |
| `-race` settings 包 | ok 21.635s |
| `gofmt -l internal/settings/ internal/provider/` | 空 |
| `go vet -tags nogui`（darwin / GOOS=linux / GOOS=windows） | 三平台干净 |
| `go build -tags nogui ./...`（darwin） | exit 0；`internal/gui/trayimage_darwin.go:112` 一条预存 cgo 警告（未触碰的文件） |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -o /dev/null .` | exit 0 |

## 普查结论（Siblings 依据）

base 上 `internal/` 非测试代码共 84 个 `settings.Save(` 调用点、55 个含 Save 的函数、30 个文件；**全部 55 个函数**的同函数内都有 `settings.Load()`/`LoadChecked()`（即全部是全量快照回写，没有"只读"或"写别的文件"的混淆项；`settings.Save` 只写 settings.json）。本单迁走 3 个；剩 52 函数 / 28 文件 / 81 调用点，完整逐函数清单在 comment body 的 Siblings 节。

## 行为细微变化（已写进 commit 与 post）

- `setModelName` 的 no-op 路径（名字已是原值）原来直接 return 不落盘；现在 Update 会把文件现有内容原样写回（一次幂等写，多一次 fsync 成本）。除此之外语义不变。
- 其余两个 setter 逐语句保持原逻辑，仅包进 Update。

## 不确定项 / 未验证

- 跨进程丢更新（CLI vs 网关/应用）不在本单修复范围：`fileMu` 仅进程内。post 已明说，方向是 settings.json 旁的锁文件。
- 变异 (a) 证据弱（见上）；如维护者质疑 Update 持锁的必要性，原缺陷的红证据（98–100/100 轮）是主要支撑。
- `-count=5/20` 的红/绿数字为本机（macOS arm64）实测；Windows 上 reporter 是 200/200，窗口更宽，只会更红。
- Siblings 里 `backup.Restore` 与 `gui/port.go` 回滚是"故意整快照写"，迁 Update 前值得单独审（已在 post 提示）。

## 本单经验（可复用）

- reporter 式单轮并发测试在本机大概率 flaky-red；"N 轮独立夹具放大 + 统计丢更新轮数"能把 55% 单轮命中率放大成整测必红，且绿的时候是确定性绿（Update 持锁后结构上不可能丢）。
- 突变验证"释锁再取"型变异时，Go mutex 的 barging 会把窗口收窄一个数量级，红证据要靠 -count 次数堆，报告中要写明弱化的原因。
