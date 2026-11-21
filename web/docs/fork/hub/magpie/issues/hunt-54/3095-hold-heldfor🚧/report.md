# #3095 处理报告 — TestHoldReadsMigrationsOnce 墙钟敏感（heldFor 1s 在两读之间耗尽）

日期：2026-10-21。worktree `/tmp/magpie-h53`，分支 `hunt54-c-hold-heldfor`，base `c922225f`。

## 结果

- **head SHA**：`de90e3eaf61693d5432583f38e2d183aecb335f1`（`de90e3ea`）
- **diff**：仅 `internal/provider/hold_test.go` +2 行（测试内 `defer 还原 heldFor + heldFor = time.Minute`），产品代码零改动
- **patch**：`docs/issues/hunt54/3095-hold-heldfor/0001-provider-TestHoldReadsMigrationsOnce-holds-past-the-.patch`
- **sha256 前 16**：`7589b02dff15dad4`
- **git am 套用验证**：一次性 clone reset 到 `c922225f` 后 `git am` 干净套用（临时目录已删）
- 仅本地；未 push、未发帖、未碰主 clone

## 假设与方向取舍（维护者两方向）

**选 a（测试内调高 heldFor）**，理由：
1. 同文件已有逐字相同的先例：`TestHoldKeptForTheNextRequest`（hold_test.go:56-57）、`TestHoldKeptUntilAWrite`（:95-96），均为维护者 ed3a46d0（引入 hold 机制的提交）所加；`group_held_test.go:289-290` 用同模式设为 time.Hour。本测试（2a4042a9 引入）是族里唯一漏保护的。
2. 方向 b（计数读取）不解除墙钟耦合：held 过期时读计数照样变 2，负载下仍红；要修还是得调高 heldFor，届时计数断言冗余。
3. `heldFor` 本就是 `var`（hold.go:108，非 const——任务简报中"需先改 var"的前提不成立），零产品代码改动。

**守卫形态**：修法 a 下注入的 1.2s sleep 在修后必然绿（held 1 分钟不会在相邻两条语句间过期），留在测试里只会拖慢每次运行且不再能证明任何事，故不进 commit；确定性守卫 = 调高后的 heldFor 本身（1 分钟 ≫ 相邻语句间隔）。RED/GREEN 证据由注入实验承担（帖中写明此取舍）。

## 机理（读码 + 注入证实）

`Moved` → `MigrationOf` → `readMigrations()` = `heldOf("migrations", readMigrationsFile)`（migrate.go:364）；held 副本仅在 `time.Since(h.at) < heldFor` 时复用（hold.go:189，heldFrom 同 :243）。测试第一次 `Moved("held-sub")`（hold_test.go:310）落 held 值（at=now），随后裸写 migrations.json——`heldFreshLocked` 只 stat providers.json/settings.json（hold.go:62），migrations.json 不在其中，故 held 过期是文件被重读的唯一路径。负载下两读间隔 >1s → 过期重建 → `Moved("other-sub")` 变 true → :316 断言红。

## 注入位置与 RED 原文

注入（实验，未进 commit）：第一次 `Moved` 之后、第二次 `Moved` 之前插 `time.Sleep(1200 * time.Millisecond)`（WriteFile 行后）。

```
=== RUN   TestHoldReadsMigrationsOnce
    hold_test.go:317: migrations.json read again while held
--- FAIL: TestHoldReadsMigrationsOnce (1.20s)
FAIL
FAIL	github.com/yetone/magpie/internal/provider	1.430s
```

（注入行使断言移到 :317；未注入的 pristine 文件即 issue 的 :316。）

## GREEN

修复 + 注入仍在：`-count=5` 5/5 绿，每次 1.22s（sleep 真实执行、held 不过期）。最终形态（无注入）：`-count=5`、`-count=10` 绿。

## 消融

1. upstream + 注入 → 红（上节原文；独立复现两次，逐字一致）；
2. 修复 + 注入 → 绿 5/5；
3. 修复、去注入（=提交形态）→ 绿（-count=3、-count=5、-count=10）；
4. heldFor 生产默认不变：diff 无产品代码，`heldFor` 仍为 hold.go:108 的 `var heldFor = time.Second`。

## Watched 三查

- (a) 打破：去掉守卫（=还原 upstream）+ 注入 → 红，即消融第 1 项，两次复现。
- (b) 用点清单：`rg 'heldFor|held\.' internal/provider --type go | grep -v _test` — 产品用点全在 hold.go（:108 定义、:133 释放时清理、:189 heldOf、:243 heldFrom）；`heldForDay`（warmup_daily.go）是无关同名前缀函数。测试守卫现状：:56、:95、group_held_test.go:289 + 本次 :308。
  - 同类暴露、issue 未点名、**Left**：`TestHoldReadsSettingsOnce`(:170，同形态：held 期裸写 settings.json + 断言 held 读)、`TestHoldBuildsProvidersOnce`(:226，两次 All() 计数恰 1，过期会变 2)。
  - 对过期容忍、**Left**：TestHoldBuildsOnce、TestHeldGoesWithAPluginChange、TestHoldSeesWrites、TestHeldGroupsAreTheCallers（断言方向本就期待重建）、TestAllReadsNoSettingsPerLookWhileHeld（注释明示预算含一次重建，looks=200 ≫ 构建读取数）、TestCursorKeychainReadOnce（自有 memo 不经 heldFor）。
- (c) 语义：held 过期即重建正是产品语义（heldOf 只在 heldFor 内复用副本）；红是测试断言被墙钟噪声触发，非产品缺陷。

## 矩阵逐项

| 项 | 命令 | 结果 | exit |
|---|---|---|---|
| 基线单跑 | `go test ./internal/provider -run TestHoldReadsMigrationsOnce -count=1` | ok 0.03s | 0 |
| RED 注入 | 同上 + sleep 1.2s | FAIL :317 | 1 |
| GREEN+注入 | `-count=5` | ok 5/5 | 0 |
| 定向 count=10 | `-count=10` | ok 0.936s | 0 |
| race 定向 | `-race -count=2` | ok，无 race | 0 |
| 全包 | `go test ./internal/provider/... -count=1 -timeout 20m` | ok 80.137s（provider-full.log） | 0 |
| gofmt | `gofmt -l internal/provider/` | 空（中途一次尾注释对齐修正后过） | 0 |
| vet | `go vet ./internal/provider/...` | ok | 0 |
| build darwin/arm64 | `go build -o /dev/null ./...` | ok（预存 cgo/ld 警告） | 0 |
| build linux/amd64 | `GOOS=linux GOARCH=amd64 -tags nogui` | ok | 0 |
| build windows/amd64 | `GOOS=windows GOARCH=amd64` | ok | 0 |
| git am | 一次性 clone + `git am` | 干净套用 | 0 |

负载模拟（yes×4 + count=20）：未跑（任务标注可选；注入已确定性证明机理）。

## 不确定项 / 如实声明

- 未在真机负载 25–57 下复现维护者现场（按 issue 建议以注入代替）。
- 两个同形测试（TestHoldReadsSettingsOnce、TestHoldBuildsProvidersOnce）同类暴露未改——issue 只点名一个，帖中 Siblings 如实列出供维护者定夺。
- go.mod/go 版本 1.26.8，GOTOOLCHAIN 未触发下载。

## 产物清单

- `0001-provider-TestHoldReadsMigrationsOnce-holds-past-the-.patch`（sha256 前 16 `7589b02dff15dad4`）
- `issue-body.md`（英文帖草稿，零中文，模型名仅在 patch 内 Generated-by）
- `commit-msg.txt`（提交所用消息）
- `provider-full.log`（全包测试输出）
- `report.md`（本文件）
